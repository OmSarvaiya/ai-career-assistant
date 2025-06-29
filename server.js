// ====================================================================
// AI Interview Assistant Backend Server
// Complete MongoDB Implementation
// ====================================================================

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');
const { OpenAI } = require('openai');


// Load environment variables
require('dotenv').config();

// Import subscription system
const SubscriptionSystem = require('./subscription-system');

const app = express();
const PORT = process.env.PORT || 5000;


console.log('🚀 Starting AI Interview Assistant Backend Server...');

// ====================================================================
// MIDDLEWARE SETUP
// ====================================================================
app.use((req, res, next) => {
    console.log(`🔧 CORS request: ${req.method} ${req.path} from: ${req.headers.origin || 'no origin'}`);
    
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    
    if (req.method === 'OPTIONS') {
        console.log('✅ Handling CORS preflight for:', req.path);
        return res.status(200).end();
    }
    
    next();
});
// Security middleware
app.use(helmet({
    contentSecurityPolicy: false // Allow external scripts for Stripe
}));


// Rate limiting - TEMPORARILY COMMENTED OUT FOR TESTING
/*
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: {
        success: false,
        error: 'Too many requests from this IP, please try again later.',
        retryAfter: '15 minutes'
    },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);
*/

// Body parsing
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});
app.use((req, res, next) => {
    console.log(`🔧 CORS request: ${req.method} ${req.path} from: ${req.headers.origin || 'no origin'}`);
    
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    
    if (req.method === 'OPTIONS') {
        console.log('✅ Handling CORS preflight for:', req.path);
        return res.status(200).end();
    }
    
    next();
});
app.use(express.static('public'));

// ====================================================================
// MONGODB SCHEMAS AND MODELS
// ====================================================================

// User Authentication Schema
const userAuthSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password_hash: { type: String, required: true },
    email_verified: { type: Boolean, default: false },
    email_verification_token: { type: String },
    password_reset_token: { type: String },
    password_reset_expires: { type: Date },
    login_attempts: { type: Number, default: 0 },
    locked_until: { type: Date },
    last_login: { type: Date }
}, { timestamps: true });

// User Session Schema
const userSessionSchema = new mongoose.Schema({
    user_id: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'UserAuth' },
    token_hash: { type: String, required: true },
    expires_at: { type: Date, required: true },
    ip_address: { type: String },
    user_agent: { type: String }
}, { timestamps: true });

// Subscription User Schema
const userSchema = new mongoose.Schema({
    email: { type: String, unique: true },
    stripe_customer_id: { type: String },
    trial_started_at: { type: Date },
    trial_used: { type: Boolean, default: false }
}, { timestamps: true });

// Subscription Schema
const subscriptionSchema = new mongoose.Schema({
    user_id: { type: String, required: true },
    stripe_customer_id: { type: String },
    stripe_subscription_id: { type: String },
    plan_id: { type: String },
    status: { type: String },
    current_period_start: { type: Date },
    current_period_end: { type: Date }
}, { timestamps: true });

// Usage Log Schema
const usageLogSchema = new mongoose.Schema({
    user_id: { type: String, required: true },
    action: { type: String, required: true },
    data: { type: String },
    ip_address: { type: String },
    user_agent: { type: String }
}, { timestamps: true });

// Payment Schema
const paymentSchema = new mongoose.Schema({
    user_id: { type: String, required: true },
    stripe_payment_intent_id: { type: String },
    amount: { type: Number },
    currency: { type: String },
    status: { type: String },
    plan_id: { type: String }
}, { timestamps: true });

// Create Models
const UserAuth = mongoose.model('UserAuth', userAuthSchema);
const UserSession = mongoose.model('UserSession', userSessionSchema);
const User = mongoose.model('User', userSchema);
const Subscription = mongoose.model('Subscription', subscriptionSchema);
const UsageLog = mongoose.model('UsageLog', usageLogSchema);
const Payment = mongoose.model('Payment', paymentSchema);

class MongoDBSubscriptionSystem {
    constructor(mongoose) {
        this.mongoose = mongoose;
        this.stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        
        // Plan definitions
        this.plans = {
            'monthly': {
                id: 'monthly',
                name: 'Monthly Pro',
                price: 1500, // $1500
                currency: 'usd',
                interval: 'month',
                interval_count: 1,
                stripe_price_id: process.env.STRIPE_PRICE_MONTHLY,
                features: [
                    'Unlimited AI responses',
                    'Real-time interview assistance',
                    'Platform auto-detection',
                    'Response history',
                    'Email support'
                ]
            },
            'quarterly': {
                id: 'quarterly',
                name: 'Quarterly Pro',
                price: 3900, // $39 
                currency: 'usd',
                interval: 'month',
                interval_count: 3,
                stripe_price_id: process.env.STRIPE_PRICE_QUARTERLY,
                features: [
                    'Unlimited AI responses',
                    'Real-time interview assistance',
                    'Platform auto-detection',
                    'Response history',
                    'Priority support',
                    'Advanced analytics'
                ]
            },
            'yearly': {
                id: 'yearly',
                name: 'Yearly Pro',
                price: 12000, // $120 (save $40)
                currency: 'usd',
                interval: 'year',
                interval_count: 1,
                stripe_price_id: process.env.STRIPE_PRICE_YEARLY,
                features: [
                    'Unlimited AI responses',
                    'Real-time interview assistance',
                    'Platform auto-detection',
                    'Response history',
                    'Priority support',
                    'Advanced analytics',
                    'Custom response training',
                    'Export interview data'
                ]
            }
        };
    }

    // Get available plans
    getPlans() {
        try {
            return {
                success: true,
                plans: Object.values(this.plans),
                message: 'Subscription plans retrieved successfully'
            };
        } catch (error) {
            console.error('❌ Failed to get plans:', error);
            return {
                success: false,
                error: 'Failed to retrieve plans',
                plans: []
            };
        }
    }

    // Generate unique IDs
    generateId() {
        return `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    // Get or create user (MongoDB version)
    async getOrCreateUser(email = null, userId = null) {
        try {
            if (userId) {
                let user = await User.findById(userId);
                if (user) {
                    return { id: user._id.toString(), email: user.email };
                }
            }

            if (email) {
                let user = await User.findOne({ email: email.toLowerCase() });
                if (user) {
                    return { id: user._id.toString(), email: user.email };
                }

                // Create new user
                const newUser = new User({
                    email: email.toLowerCase()
                });
                await newUser.save();
                return { id: newUser._id.toString(), email: newUser.email };
            }

            throw new Error('Either email or userId must be provided');
        } catch (error) {
            console.error('❌ User operation failed:', error);
            throw error;
        }
    }

    // Create Stripe checkout session
    async createCheckoutSession(planId, userId, successUrl, cancelUrl) {
        try {
            console.log('📝 Creating checkout session for plan:', planId);
            console.log('📝 Input userId:', userId, typeof userId);

            const plan = this.plans[planId];
            if (!plan) {
                throw new Error('Invalid plan ID');
            }

            if (!plan.stripe_price_id) {
                throw new Error(`Stripe price ID not configured for plan: ${planId}`);
            }

            // For MongoDB - create user with string ID
            let user;
            
            // If userId is provided, try to find or create user
            if (userId) {
                try {
                    // Try to find existing user by string ID
                    user = await User.findOne({ _id: userId });
                    if (user) {
                        console.log('✅ Found existing user');
                    } else {
                        // Create new user with the provided ID
                        user = new User({
                            _id: userId, // Use the provided string ID
                            email: `${userId}@example.com`
                        });
                        await user.save();
                        console.log('✅ Created new user with string ID');
                    }
                } catch (error) {
                    // If userId is not a valid ObjectId, create with auto-generated ID
                    user = new User({
                        email: `user-${Date.now()}@example.com`
                    });
                    await user.save();
                    console.log('✅ Created new user with auto-generated ID');
                }
            } else {
                // Create new user with auto-generated ID
                user = new User({
                    email: `user-${Date.now()}@example.com`
                });
                await user.save();
                console.log('✅ Created new user (no userId provided)');
            }

            // CRITICAL: Always convert ObjectId to string
            const userIdString = user._id.toString();
            console.log('🔧 Final userIdString:', userIdString, typeof userIdString);

            // Create Stripe checkout session
            const session = await this.stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                line_items: [{
                    price: plan.stripe_price_id,
                    quantity: 1,
                }],
                mode: 'subscription',
                success_url: successUrl,
                cancel_url: cancelUrl,
                metadata: {
                    user_id: userIdString, // ✅ GUARANTEED STRING
                    plan_id: planId
                },
                customer_email: user.email || undefined
            });

            console.log('✅ Checkout session created:', session.id);

            return {
                success: true,
                session_id: session.id,
                checkout_url: session.url,
                plan: {
                    id: plan.id,
                    name: plan.name,
                    price: plan.price,
                    currency: plan.currency,
                    interval: plan.interval
                }
            };

        } catch (error) {
            console.error('❌ Checkout session creation failed:', error);
            throw new Error(`Checkout session creation failed: ${error.message}`);
        }
    }

    // Verify payment (MongoDB version)
    async verifyPayment(sessionId, userId) {
        try {
            console.log('🔍 Verifying payment for session:', sessionId);

            if (!sessionId) {
                throw new Error('Session ID is required');
            }

            // Retrieve checkout session from Stripe
            const session = await this.stripe.checkout.sessions.retrieve(sessionId, {
                expand: ['subscription']
            });

            if (session.payment_status !== 'paid') {
                throw new Error(`Payment not completed. Status: ${session.payment_status}`);
            }

            // Get subscription details
            const stripeSubscription = session.subscription;

            if (!stripeSubscription || stripeSubscription.status !== 'active') {
                throw new Error(`Subscription not active. Status: ${stripeSubscription?.status}`);
            }

            // Get user
            const user = await this.getOrCreateUser(null, userId || session.metadata.user_id);

            // Create subscription record
            const subscriptionId = this.generateId();
            const planId = session.metadata.plan_id;
            const plan = this.plans[planId];

            if (!plan) {
                throw new Error('Invalid plan in session metadata');
            }

            // Save subscription to MongoDB
            const newSubscription = new Subscription({
                _id: subscriptionId,
                user_id: user.id,
                stripe_customer_id: session.customer,
                stripe_subscription_id: stripeSubscription.id,
                plan_id: planId,
                status: 'active',
                current_period_start: new Date(stripeSubscription.current_period_start * 1000),
                current_period_end: new Date(stripeSubscription.current_period_end * 1000)
            });

            await newSubscription.save();

            // Log payment
            const newPayment = new Payment({
                _id: session.payment_intent,
                user_id: user.id,
                stripe_payment_intent_id: session.payment_intent,
                amount: plan.price,
                currency: plan.currency,
                status: 'succeeded',
                plan_id: planId
            });

            await newPayment.save();

            // Log subscription activation
            await this.logUsage(user.id, 'subscription_activated', {
                planId,
                subscriptionId,
                amount: plan.price,
                stripe_subscription_id: stripeSubscription.id
            });

            console.log('✅ Subscription activated:', subscriptionId);

            return {
                success: true,
                message: 'Subscription activated successfully',
                subscription: {
                    id: subscriptionId,
                    planId: planId,
                    planName: plan.name,
                    status: 'active',
                    duration: plan.interval === 'year' ? 365 : (plan.interval_count || 1) * 30,
                    expiryDate: newSubscription.current_period_end,
                    autoRenew: true,
                    features: plan.features
                }
            };

        } catch (error) {
            console.error('❌ Payment verification failed:', error);
            throw new Error(`Payment verification failed: ${error.message}`);
        }
    }

    // Get subscription status (MongoDB version)
    async getSubscriptionStatus(userId) {
        try {
            console.log('📊 Checking subscription status for user:', userId);

            // Get user
            const user = await User.findById(userId);
            if (!user) {
                // Return trial status for new users
                return {
                    success: true,
                    subscription: {
                        status: 'trial',
                        plan: null,
                        expiryDate: null,
                        features: ['Limited AI responses (10 per day)'],
                        trialData: {
                            responses_used: 0,
                            responses_limit: 10,
                            started_at: new Date().toISOString()
                        },
                        usageCount: 0
                    }
                };
            }

            // Get active subscription
            const subscription = await Subscription.findOne({ 
                user_id: userId, 
                status: 'active',
                current_period_end: { $gte: new Date() }
            });

            if (subscription) {
                const plan = this.plans[subscription.plan_id];
                return {
                    success: true,
                    subscription: {
                        status: 'active',
                        plan: plan?.name || 'Unknown Plan',
                        planId: subscription.plan_id,
                        expiryDate: subscription.current_period_end,
                        features: plan?.features || [],
                        usageCount: await this.getUsageCount(userId),
                        subscriptionId: subscription._id
                    }
                };
            }

            // Check if user has used trial
            if (user.trial_used) {
                return {
                    success: true,
                    subscription: {
                        status: 'expired',
                        plan: null,
                        expiryDate: null,
                        features: [],
                        message: 'Subscription expired. Please upgrade to continue.',
                        usageCount: 0
                    }
                };
            }

            // Return trial status
            return {
                success: true,
                subscription: {
                    status: 'trial',
                    plan: null,
                    expiryDate: null,
                    features: ['Limited AI responses (10 per day)'],
                    trialData: {
                        responses_used: 0,
                        responses_limit: 10,
                        started_at: user.createdAt || new Date().toISOString()
                    },
                    usageCount: 0
                }
            };

        } catch (error) {
            console.error('❌ Subscription status check failed:', error);
            return {
                success: false,
                error: 'Failed to check subscription status',
                subscription: {
                    status: 'error',
                    plan: null,
                    expiryDate: null,
                    features: [],
                    usageCount: 0
                }
            };
        }
    }

    // Start trial (MongoDB version)
   // ✅ REPLACE YOUR startTrial() METHOD (around line 648) WITH THIS:

// Start trial (MongoDB version) - FIXED
async startTrial(userId, userEmail) {  // ✅ ADD EMAIL PARAMETER
    try {
        if (!userId || !userEmail) {  // ✅ CHECK BOTH
            throw new Error('User ID and email are required');
        }

        console.log('🎯 Starting trial for user:', userId, userEmail);

        // ✅ FIND USER BY EMAIL OR ID (PREVENTS DUPLICATE NULL EMAILS)
        let user = await User.findOne({
            $or: [
                { _id: userId },
                { email: userEmail }
            ]
        });

        // ✅ CHECK IF USER ALREADY USED TRIAL
        if (user && user.trial_used) {
            console.log('❌ User already used trial:', userEmail);
            throw new Error('Trial already used for this user');
        }

        // ✅ CHECK IF USER HAS ACTIVE TRIAL
        if (user && user.trial_started_at) {
            const trialStart = new Date(user.trial_started_at);
            const trialDuration = 10 * 60 * 1000; // 10 minutes
            const trialEnd = new Date(trialStart.getTime() + trialDuration);
            const now = new Date();

            if (now < trialEnd) {
                const minutesLeft = Math.ceil((trialEnd - now) / (1000 * 60));
                console.log('✅ User has active trial:', minutesLeft, 'minutes left');
                return {
                    success: true,
                    message: 'Trial already active',
                    trial: {
                        startTime: trialStart.getTime(),
                        duration: trialDuration,
                        endTime: trialEnd.getTime(),
                        minutesLeft: minutesLeft,
                        isActive: true
                    }
                };
            }
        }

        // ✅ START NEW TRIAL - CREATE OR UPDATE USER
        const now = Date.now();

        if (!user) {
            // ✅ CREATE NEW USER WITH EMAIL
            const newUser = new User({
                _id: userId,
                email: userEmail,  // ✅ ALWAYS INCLUDE EMAIL
                trial_started_at: new Date(now),
                trial_used: true   // Mark as used immediately
            });
            await newUser.save();
            console.log('✅ Created new user with trial:', userEmail);
        } else {
            // ✅ UPDATE EXISTING USER
            await User.findOneAndUpdate(
                { $or: [{ _id: userId }, { email: userEmail }] },
                {
                    $set: {
                        trial_started_at: new Date(now),
                        trial_used: true,  // Mark as used immediately
                        email: userEmail   // Ensure email is set
                    }
                }
            );
            console.log('✅ Updated existing user with trial:', userEmail);
        }

        // ✅ LOG USAGE
        await this.logUsage(userId, 'trial_started', {
            userEmail: userEmail,
            trialType: 'free_10_minute'
        });

        // ✅ RETURN SUCCESS WITH TRIAL DATA
        return {
            success: true,
            message: 'Trial started successfully',
            trial: {
                startTime: now,
                duration: 10 * 60 * 1000, // 10 minutes in milliseconds
                endTime: now + (10 * 60 * 1000),
                minutesLeft: 10,
                isActive: true,
                isUnlimited: true,
                trialType: 'free_10_minute'
            }
        };

    } catch (error) {
        console.error('❌ Trial start failed:', error);
        
        // ✅ BETTER ERROR HANDLING
        if (error.message.includes('duplicate key') || error.message.includes('E11000')) {
            throw new Error('Account conflict detected. Please logout and login again with your email.');
        } else {
            throw new Error(`Trial start failed: ${error.message}`);
        }
    }
}

    // Log usage (MongoDB version)
    async logUsage(userId, action, data = {}) {
        try {
            const newLog = new UsageLog({
                user_id: userId,
                action: action,
                data: JSON.stringify(data)
            });
            await newLog.save();
        } catch (error) {
            console.error('❌ Usage logging failed:', error);
        }
    }

    // Get usage count
    async getUsageCount(userId) {
        try {
            const count = await UsageLog.countDocuments({ 
                user_id: userId,
                action: 'ai_response_generated',
                createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Last 24 hours
            });
            return count;
        } catch (error) {
            console.error('❌ Usage count failed:', error);
            return 0;
        }
    }

    // Update usage (MongoDB version)
    async updateUsage(userId, action, metadata = {}) {
        try {
            await this.logUsage(userId, action, metadata);

            return {
                success: true,
                message: 'Usage updated successfully',
                action: action,
                timestamp: new Date().toISOString()
            };

        } catch (error) {
            console.error('❌ Usage update failed:', error);
            throw new Error(`Usage update failed: ${error.message}`);
        }
    }

    // Cancel subscription (MongoDB version)
    async cancelSubscription(subscriptionId, userId, reason = 'User requested') {
        try {
            console.log('🚫 Cancelling subscription:', subscriptionId);

            const subscription = await Subscription.findOne({ 
                _id: subscriptionId, 
                user_id: userId 
            });

            if (!subscription) {
                throw new Error('Subscription not found');
            }

            // Cancel in Stripe
            await this.stripe.subscriptions.update(subscription.stripe_subscription_id, {
                cancel_at_period_end: true
            });

            // Update in database
            await Subscription.findByIdAndUpdate(subscriptionId, {
                status: 'cancelled'
            });

            await this.logUsage(userId, 'subscription_cancelled', {
                subscriptionId,
                reason
            });

            return {
                success: true,
                message: 'Subscription cancelled successfully',
                cancellation: {
                    effective_date: subscription.current_period_end,
                    access_until: subscription.current_period_end
                }
            };

        } catch (error) {
            console.error('❌ Subscription cancellation failed:', error);
            throw new Error(`Subscription cancellation failed: ${error.message}`);
        }
    }

    // Get user analytics (MongoDB version)
    async getUserAnalytics(userId) {
        try {
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

            const analytics = await UsageLog.aggregate([
                { $match: { user_id: userId, createdAt: { $gte: thirtyDaysAgo } } },
                { $group: { _id: '$action', count: { $sum: 1 } } },
                { $sort: { count: -1 } }
            ]);

            const totalUsage = await UsageLog.countDocuments({ 
                user_id: userId,
                createdAt: { $gte: thirtyDaysAgo }
            });

            return {
                success: true,
                analytics: {
                    total_actions: totalUsage,
                    period: '30 days',
                    breakdown: analytics,
                    most_used_feature: analytics[0]?._id || 'none'
                }
            };

        } catch (error) {
            console.error('❌ Analytics fetch failed:', error);
            return {
                success: false,
                error: 'Failed to fetch analytics'
            };
        }
    }
}

// ====================================================================
// MONGODB CONNECTION
// ====================================================================

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/ai-interview-assistant';

mongoose.connect(MONGODB_URI)
    .then(() => {
        console.log('📊 Connected to MongoDB successfully');
        console.log('🗄️ Database:', MONGODB_URI);
    })
    .catch((err) => {
        console.error('❌ MongoDB connection error:', err);
        process.exit(1);
    });
let openai = null;
if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
    });
    console.log('🤖 OpenAI initialized successfully');
} else {
    console.warn('⚠️ OPENAI_API_KEY not found in environment variables');
}
// ====================================================================
// AUTHENTICATION CONFIGURATION & UTILITY FUNCTIONS
// ====================================================================
// Initialize OpenAI

// Safe Email configuration with proper error handling
let emailTransporter = null;

try {
    console.log('📧 Attempting to configure email service...');
    
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        emailTransporter = nodemailer.createTransport({
            service: 'gmail', // Use service instead of host for better compatibility
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });
        console.log('📧 Email transporter created successfully');
        
        // Verify email configuration
        emailTransporter.verify()
            .then(() => console.log('📧 Email service verified successfully'))
            .catch(err => {
                console.log('⚠️ Email verification failed:', err.message);
                console.log('📧 Email features will be disabled');
                emailTransporter = null;
            });
    } else {
        console.log('📧 Email credentials not provided - email features disabled');
        console.log('📧 Set EMAIL_USER and EMAIL_PASS in .env to enable email verification');
    }
} catch (error) {
    console.log('⚠️ Email setup failed:', error.message);
    console.log('📧 Continuing without email functionality - authentication will still work');
    emailTransporter = null;
}

// JWT Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your-fallback-secret-key-for-development';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

// Authentication utility functions
const hashPassword = async (password) => {
    const saltRounds = 12;
    return await bcrypt.hash(password, saltRounds);
};

const verifyPassword = async (password, hash) => {
    return await bcrypt.compare(password, hash);
};

const generateUserId = () => {
    return `user_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
};

const generateToken = () => {
    return crypto.randomBytes(32).toString('hex');
};

const generateJWTToken = (user) => {
    return jwt.sign(
        { 
            userId: user.id || user._id, 
            email: user.email,
            name: user.name
        },
        JWT_SECRET,
        { 
            expiresIn: JWT_EXPIRES_IN,
            issuer: 'ai-interview-assistant',
            audience: 'ai-interview-users'
        }
    );
};

// Authentication middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({
            success: false,
            error: 'Access token is required'
        });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            console.error('JWT verification error:', err);
            return res.status(403).json({
                success: false,
                error: 'Invalid or expired token'
            });
        }

        req.user = user;
        next();
    });
};

// ====================================================================
// EMAIL FUNCTIONS
// ====================================================================

// Email sending functions - Safe version with fallback
const sendVerificationEmail = async (email, name, token) => {
    if (!emailTransporter) {
        console.log('📧 [DEV MODE] Email not configured - logging verification details:');
        console.log('📧 [DEV MODE] User:', email);
        console.log('📧 [DEV MODE] Verification token:', token);
        console.log('📧 [DEV MODE] Manual verification URL: http://localhost:5000/verify-email?token=' + token);
        console.log('📧 [DEV MODE] For development, user will be auto-verified');
        return Promise.resolve();
    }
    
    try {
        const verificationUrl = `${process.env.FRONTEND_URL || 'http://localhost:5000'}/verify-email?token=${token}`;
        
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: email,
            subject: 'Verify Your AI Interview Assistant Account',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #667eea;">Welcome to AI Interview Assistant!</h2>
                    <p>Hi ${name},</p>
                    <p>Thank you for signing up! Please verify your email address by clicking the button below:</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${verificationUrl}" 
                           style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                                  color: white; padding: 15px 30px; text-decoration: none; 
                                  border-radius: 8px; display: inline-block;">
                            Verify Email Address
                        </a>
                    </div>
                    <p>If the button doesn't work, copy and paste this link into your browser:</p>
                    <p>${verificationUrl}</p>
                    <p>This link will expire in 24 hours.</p>
                    <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;">
                    <p style="color: #666; font-size: 12px;">
                        If you didn't sign up for AI Interview Assistant, please ignore this email.
                    </p>
                </div>
            `
        };

        await emailTransporter.sendMail(mailOptions);
        console.log('📧 Verification email sent successfully to:', email);
    } catch (error) {
        console.error('📧 Failed to send verification email:', error.message);
        console.log('📧 Verification token for manual use:', token);
        // Don't throw error - let registration continue
    }
};

// ====================================================================
// AUTHENTICATION ROUTES - MONGODB VERSION
// ====================================================================

app.post('/api/auth/signup', async (req, res) => {
    try {
        const { name, email, password } = req.body;

        // Validation
        if (!name || !email || !password) {
            return res.status(400).json({
                success: false,
                error: 'Name, email, and password are required'
            });
        }

        // Email format validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                success: false,
                error: 'Please enter a valid email address'
            });
        }

        // Password strength validation
        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                error: 'Password must be at least 6 characters long'
            });
        }

        // Check if user already exists
        const existingUser = await UserAuth.findOne({ email: email.toLowerCase() });
        if (existingUser) {
            return res.status(400).json({
                success: false,
                error: 'An account with this email already exists'
            });
        }

        // Hash password and generate tokens
        const passwordHash = await hashPassword(password);
        const verificationToken = generateToken();

        // Create user (let MongoDB auto-generate _id)
        const newUser = new UserAuth({
            name,
            email: email.toLowerCase(),
            password_hash: passwordHash,
            email_verification_token: verificationToken,
            email_verified: !emailTransporter
        });

        await newUser.save();

        // Send verification email
        try {
            await sendVerificationEmail(email, name, verificationToken);
        } catch (emailError) {
            console.error('Failed to send verification email:', emailError);
        }

        res.json({
            success: true,
            message: emailTransporter ? 
                'Account created successfully. Please check your email to verify your account.' :
                'Account created successfully. Email verification disabled in development mode - you can login immediately.',
            user: {
                id: newUser._id,
                name,
                email: email.toLowerCase(),
                emailVerified: !emailTransporter
            }
        });

    } catch (error) {
        console.error('❌ SIGNUP ERROR DETAILS:', error);
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        res.status(500).json({
            success: false,
            error: 'Failed to create account. Please try again.',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// User Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                error: 'Email and password are required'
            });
        }

        // Get user from database
        const user = await UserAuth.findOne({ email: email.toLowerCase() });

        if (!user) {
            return res.status(401).json({
                success: false,
                error: 'Invalid email or password'
            });
        }

        // Check if account is locked
        if (user.locked_until && new Date() < user.locked_until) {
            return res.status(423).json({
                success: false,
                error: 'Account temporarily locked due to too many failed login attempts. Please try again later.'
            });
        }

        // Verify password
        const isValidPassword = await verifyPassword(password, user.password_hash);
        
        if (!isValidPassword) {
            // Increment login attempts
            const newAttempts = (user.login_attempts || 0) + 1;
            const lockUntil = newAttempts >= 5 ? new Date(Date.now() + 30 * 60 * 1000) : null;

            await UserAuth.findByIdAndUpdate(user._id, {
                login_attempts: newAttempts,
                locked_until: lockUntil
            });

            return res.status(401).json({
                success: false,
                error: 'Invalid email or password'
            });
        }

        // Check if email is verified (skip check in development mode)
        if (!user.email_verified && emailTransporter) {
            return res.status(401).json({
                success: false,
                error: 'Please verify your email address before logging in',
                needsVerification: true
            });
        }

        // Reset login attempts and update last login
        await UserAuth.findByIdAndUpdate(user._id, {
            login_attempts: 0,
            locked_until: null,
            last_login: new Date()
        });

        // Generate JWT token
        const token = generateJWTToken({ id: user._id, email: user.email, name: user.name });

        // Create session record
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        const newSession = new UserSession({
            user_id: user._id,
            token_hash: tokenHash,
            expires_at: expiresAt,
            ip_address: req.ip,
            user_agent: req.get('User-Agent')
        });

        await newSession.save();

        res.json({
            success: true,
            message: 'Login successful',
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                emailVerified: user.email_verified
            }
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            error: 'Login failed. Please try again.'
        });
    }
});

// ====================================================================
// 🤖 FINAL AI ENDPOINT - REPLACE YOUR EXISTING app.post('/api/ai/generate-response')
// ====================================================================

app.post('/api/ai/generate-response', async (req, res) => {
    try {
        console.log('🤖 AI response request received');
        const { question, context, user_id } = req.body;
        
        if (!question) {
            return res.status(400).json({
                success: false,
                error: 'Question is required'
            });
        }
        
        console.log('📝 Processing question:', question.substring(0, 50) + '...');
        console.log('👤 User ID:', user_id || 'guest');
        console.log('📋 Context:', context || 'interview');
        
        let aiResponse;
        let tokensUsed = 0;
        let responseSource = 'fallback';
        
        // Try OpenAI if configured
        if (openai) {
            try {
                console.log('🔗 Calling OpenAI API...');
                
                const completion = await openai.chat.completions.create({
                    model: 'gpt-4o-mini',
                    messages: [
                        {
                            role: 'system',
                            content: `You are an expert interview coach helping someone answer interview questions professionally and concisely.

Guidelines:
- Provide specific, actionable responses in 1-2 sentences
- Use the STAR method when relevant (Situation, Task, Action, Result)
- Be confident but humble
- Focus on skills, experience, and value proposition
- Keep responses under 150 words
- Sound natural and conversational
- Answer in first person as if you are the candidate

Context: ${context || 'Interview'} interview
Current time: ${new Date().toLocaleString()}`
                        },
                        {
                            role: 'user',
                            content: `Interview Question: "${question}"

Please provide a professional first-person response that:
1. Directly answers the question
2. Uses specific examples when possible
3. Demonstrates relevant skills and experience
4. Sounds natural and conversational
5. Is concise (1-2 sentences, under 150 words)

Response:`
                        }
                    ],
                    max_tokens: 200,
                    temperature: 0.7,
                    top_p: 0.9
                });
                
                aiResponse = completion.choices[0]?.message?.content || 'Unable to generate response.';
                tokensUsed = completion.usage?.total_tokens || 0;
                responseSource = 'openai';
                
                console.log('✅ OpenAI response generated successfully');
                console.log('📊 Tokens used:', tokensUsed);
                
            } catch (openaiError) {
                console.error('❌ OpenAI API error:', openaiError.message);
                
                // Check for specific OpenAI errors
                if (openaiError.status === 401) {
                    console.error('🔑 Invalid OpenAI API key');
                } else if (openaiError.status === 429) {
                    console.error('⏳ OpenAI rate limit exceeded');
                } else if (openaiError.status === 500) {
                    console.error('🔧 OpenAI server error');
                }
                
                // Use fallback on OpenAI error
                aiResponse = generateSmartFallback(question);
                responseSource = 'fallback_openai_error';
            }
        } else {
            console.log('⚠️ OpenAI not configured, using fallback');
            aiResponse = generateSmartFallback(question);
            responseSource = 'fallback_no_api';
        }
        
        // Track usage if subscription system is available and user provided
        if (user_id && typeof subscriptionSystem !== 'undefined') {
            try {
                await subscriptionSystem.updateUsage(user_id, 'ai_response_generated', { 
                    question_length: question.length,
                    response_length: aiResponse.length,
                    tokens_used: tokensUsed,
                    source: responseSource,
                    timestamp: new Date()
                });
                console.log('📊 Usage tracked for user:', user_id);
            } catch (usageError) {
                console.warn('⚠️ Usage tracking failed:', usageError.message);
            }
        }
        
        // Return successful response
        res.json({
            success: true,
            response: aiResponse,
            tokens_used: tokensUsed,
            source: responseSource,
            user_id: user_id || null,
            timestamp: new Date().toISOString(),
            fallback: responseSource.includes('fallback')
        });
        
    } catch (error) {
        console.error('❌ AI generation critical error:', error);
        
        // Emergency fallback response
        const emergencyResponse = generateSmartFallback(req.body.question || 'general interview question');
        
        res.json({
            success: true,
            response: emergencyResponse,
            tokens_used: 0,
            source: 'emergency_fallback',
            fallback: true,
            error_handled: true,
            timestamp: new Date().toISOString()
        });
    }
});

// ====================================================================
// 🎯 CONTEXTUAL AI ENDPOINT (also add this if you don't have it)
// ====================================================================

app.post('/api/ai/contextual-response', async (req, res) => {
    try {
        console.log('🎯 Contextual AI response request received');
        const { question, context, resumeData, interviewType, user_id } = req.body;
        
        if (!question) {
            return res.status(400).json({
                success: false,
                error: 'Question is required'
            });
        }
        
        console.log('📝 Processing contextual question:', question.substring(0, 50) + '...');
        console.log('📋 Has resume data:', !!(resumeData && Object.keys(resumeData).length > 0));
        
        let aiResponse;
        let tokensUsed = 0;
        let responseSource = 'fallback';
        
        if (openai) {
            try {
                // Build enhanced system prompt with resume data
                let systemPrompt = `You are an expert interview coach providing personalized responses based on the candidate's background.

CANDIDATE PROFILE:`;

                if (resumeData && Object.keys(resumeData).length > 0) {
                    if (resumeData.name) systemPrompt += `\nName: ${resumeData.name}`;
                    if (resumeData.title) systemPrompt += `\nTitle: ${resumeData.title}`;
                    if (resumeData.summary) systemPrompt += `\nSummary: ${resumeData.summary}`;
                    if (resumeData.skills && resumeData.skills.length > 0) {
                        systemPrompt += `\nKey Skills: ${resumeData.skills.slice(0, 5).join(', ')}`;
                    }
                    if (resumeData.experience && resumeData.experience.length > 0) {
                        systemPrompt += `\nRecent Experience: ${resumeData.experience.slice(0, 2).map(exp => 
                            `${exp.title} at ${exp.company} (${exp.duration})`
                        ).join('; ')}`;
                    }
                } else {
                    systemPrompt += `\nNo specific background provided - use general professional experience`;
                }

                systemPrompt += `

RESPONSE GUIDELINES:
- Answer in first person as the candidate
- Draw from the candidate's actual experience and skills when available
- Provide specific examples when possible
- Keep responses conversational and confident
- Use 1-2 sentences maximum (under 150 words)
- Sound authentic to this person's background
- Interview Type: ${interviewType || 'General'}
- Platform: ${context?.platform || 'Interview'}`;

                const completion = await openai.chat.completions.create({
                    model: 'gpt-4o-mini',
                    messages: [
                        {
                            role: 'system',
                            content: systemPrompt
                        },
                        {
                            role: 'user',
                            content: `Interview Question: "${question}"

Please provide a professional first-person response that:
1. Directly answers the question
2. Uses specific examples from my background when relevant
3. Demonstrates my skills and experience
4. Sounds natural and conversational
5. Is concise (1-2 sentences, under 150 words)

Response:`
                        }
                    ],
                    max_tokens: 250,
                    temperature: 0.6
                });

                aiResponse = completion.choices[0]?.message?.content || 'Unable to generate contextual response.';
                tokensUsed = completion.usage?.total_tokens || 0;
                responseSource = 'openai_contextual';
                
                console.log('✅ Contextual OpenAI response generated');

            } catch (openaiError) {
                console.error('❌ Contextual OpenAI error:', openaiError.message);
                aiResponse = generateContextualFallback(question, resumeData);
                responseSource = 'contextual_fallback';
            }
        } else {
            aiResponse = generateContextualFallback(question, resumeData);
            responseSource = 'contextual_fallback_no_api';
        }

        res.json({
            success: true,
            response: aiResponse,
            tokens_used: tokensUsed,
            source: responseSource,
            hasResumeData: !!(resumeData && Object.keys(resumeData).length > 0),
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Contextual AI generation error:', error);
        
        const fallbackResponse = generateContextualFallback(req.body.question, req.body.resumeData);
        
        res.json({
            success: true,
            response: fallbackResponse,
            tokens_used: 0,
            source: 'contextual_emergency_fallback',
            fallback: true,
            timestamp: new Date().toISOString()
        });
    }
});

// ====================================================================
// 🛠️ HELPER FUNCTIONS (add these to your server.js)
// ====================================================================

function generateSmartFallback(question) {
    const questionLower = question.toLowerCase();
    
    // Question-specific professional responses
    if (questionLower.includes('tell me about yourself') || questionLower.includes('introduce yourself')) {
        return "I'm a dedicated professional with a strong background in problem-solving and team collaboration. I'm passionate about delivering high-quality results and contributing to organizational success.";
    }
    
    if (questionLower.includes('experience') || questionLower.includes('background')) {
        return "Throughout my career, I've gained diverse experience that has prepared me to tackle complex challenges and contribute meaningfully to team success.";
    }
    
    if (questionLower.includes('strength') || questionLower.includes('skills')) {
        return "My strengths include strong analytical thinking, effective communication, and the ability to collaborate across teams to achieve shared goals.";
    }
    
    if (questionLower.includes('weakness') || questionLower.includes('improve')) {
        return "I continuously work on improving my skills and am always open to feedback as a way to grow professionally and deliver better results.";
    }
    
    if (questionLower.includes('why') && (questionLower.includes('company') || questionLower.includes('join'))) {
        return "I'm drawn to this company because of its reputation for innovation and excellence. I believe my skills and experience align well with your team's goals.";
    }
    
    if (questionLower.includes('goal') || questionLower.includes('future') || questionLower.includes('years')) {
        return "My goal is to continue growing professionally while contributing to meaningful projects that drive business success and make a positive impact.";
    }
    
    if (questionLower.includes('challenge') || questionLower.includes('difficult') || questionLower.includes('problem')) {
        return "I approach challenges by first analyzing the situation thoroughly, then developing a clear action plan with specific steps to achieve the desired outcome.";
    }
    
    // Generic professional responses for other questions
    const genericResponses = [
        "Based on my experience, I believe in taking a systematic approach and focusing on delivering high-quality results that align with team objectives.",
        "I approach this by first understanding the requirements clearly, then developing a strategic plan that leverages my skills to achieve the best outcome.",
        "In my experience, success comes from combining technical expertise with strong communication and collaboration skills to drive meaningful results.",
        "My approach is to listen carefully, analyze the situation thoroughly, and then apply my experience to deliver value while maintaining high professional standards."
    ];
    
    return genericResponses[Math.floor(Math.random() * genericResponses.length)];
}

function generateContextualFallback(question, resumeData) {
    const questionLower = question.toLowerCase();
    
    // Use resume data if available
    if (resumeData && Object.keys(resumeData).length > 0) {
        if (questionLower.includes('tell me about yourself') && resumeData.summary) {
            return `${resumeData.summary} I'm excited about this opportunity to contribute my experience to your team.`;
        }
        
        if (questionLower.includes('experience') && resumeData.experience && resumeData.experience.length > 0) {
            const latestExp = resumeData.experience[0];
            return `In my role as ${latestExp.title} at ${latestExp.company}, I gained valuable experience that directly relates to this position and prepared me for new challenges.`;
        }
        
        if (questionLower.includes('strength') && resumeData.skills && resumeData.skills.length > 0) {
            const topSkills = resumeData.skills.slice(0, 3).join(', ');
            return `My key strengths include ${topSkills}, which I've successfully applied in previous roles to deliver impactful results.`;
        }
    }
    
    // Fall back to smart generic responses
    return generateSmartFallback(question);
}

// ====================================================================
// 🔍 AI HEALTH CHECK ENDPOINT (add this too)
// ====================================================================

app.get('/api/ai/health', (req, res) => {
    res.json({
        success: true,
        service: 'AI Interview Assistant',
        version: '1.0.0',
        endpoints: {
            generate_response: '/api/ai/generate-response',
            contextual_response: '/api/ai/contextual-response',
            health_check: '/api/ai/health'
        },
        openai_configured: !!process.env.OPENAI_API_KEY,
        openai_available: !!openai,
        environment: process.env.NODE_ENV || 'development',
        timestamp: new Date().toISOString()
    });
});


app.get('/privacy', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Privacy Policy - AI Interview Assistant</title>
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
            max-width: 800px; 
            margin: 0 auto; 
            padding: 40px 20px; 
            line-height: 1.6; 
            color: #333;
        }
        h1 { color: #2a5298; border-bottom: 3px solid #2a5298; padding-bottom: 10px; }
        h2 { color: #2a5298; margin-top: 30px; }
        h3 { color: #666; margin-top: 25px; }
        .contact { background: #f8f9ff; padding: 20px; border-radius: 8px; margin: 20px 0; }
    </style>
</head>
<body>
    <h1>Privacy Policy - AI Interview Assistant</h1>
    <p><strong>Effective Date:</strong> June 28, 2025<br>
    <strong>Last Updated:</strong> June 28, 2025</p>
    
    <h2>Overview</h2>
    <p>Overview
AI Interview Assistant ("we," "our," or "us") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, and safeguard your information when you use our Chrome extension and web platform.
Information We Collect
Account Information

Email address (for account creation and login)
Name (for personalized responses)
Password (encrypted and securely stored)

Profile Data

Resume content (when uploaded by user)
Target company and position information
Years of experience
Interview preferences and settings

Usage Data

Number of AI responses generated
Session duration and timing
Feature usage statistics
Error logs for service improvement

Technical Data

Browser type and version
Extension version
IP address (for security purposes)
Device information (for compatibility)

How We Use Your Information
Core Services

Generate personalized AI interview responses
Maintain your account and preferences
Provide customer support
Process payments and subscriptions

Service Improvement

Analyze usage patterns to improve features
Fix bugs and technical issues
Develop new functionality
Ensure service reliability

Communication

Send important account updates
Provide customer support responses
Share service announcements (optional)

Audio Data Processing
Real-Time Processing

Audio is processed in real-time for question detection
No audio recordings are permanently stored
Audio data is immediately discarded after processing
We do not save, share, or analyze your voice data

User Control

Audio processing can be disabled at any time
Users can choose manual input instead of audio
Complete control over when audio capture is active

Data Storage and Security
Security Measures

All data encrypted in transit and at rest
Secure authentication with industry-standard protocols
Regular security audits and updates
Restricted access to user data

Data Retention

Account data: Retained until account deletion
Usage statistics: Aggregated data kept for service improvement
Audio data: Not stored (processed in real-time only)
Session data: Automatically cleared after 30 days

Data Sharing
We Do Not Sell Your Data
We never sell, rent, or trade your personal information to third parties.
Limited Sharing
We may share data only in these specific cases:

Service Providers: Trusted partners who help operate our service (hosting, payment processing)
Legal Requirements: When required by law or to protect our rights
Business Transfer: In case of merger or acquisition (with prior notice)

AI Processing

Interview questions and responses are processed by AI services
No personally identifiable information is sent to AI providers
Questions are processed anonymously for response generation

Your Rights and Choices
Account Control

Access and update your profile information
Download your data (account export)
Delete your account and associated data
Opt-out of non-essential communications

Privacy Settings

Control audio processing preferences
Manage data sharing settings
Choose information included in AI processing
Set retention preferences for conversation history

Cookies and Tracking
Essential Cookies

Authentication tokens (required for login)
Session management
Security and fraud prevention

Analytics

Anonymous usage statistics
Feature performance monitoring
Error tracking for service improvement

Third-Party Services

Payment processing (Stripe)
Web hosting (Railway)
Authentication services

Children's Privacy
Our service is not intended for users under 13 years of age. We do not knowingly collect personal information from children under 13. If we become aware of such collection, we will delete the information immediately.
International Users
Our service is hosted in the United States. By using our service, you consent to the transfer of your information to the United States, which may have different privacy laws than your country.
Changes to This Policy
We may update this Privacy Policy from time to time. We will notify users of significant changes via:

Email notification to registered users
Notice on our website
Update notification in the extension

Continued use of our service after changes constitutes acceptance of the updated policy.
Contact Information
If you have questions about this Privacy Policy or our privacy practices, please contact us:
Email: optimizerresume@gmail.com
Website: https://ai-career-assistant-production.up.railway.app
Mail: AI Career Assistant Privacy Team
Compliance
This Privacy Policy complies with:

California Consumer Privacy Act (CCPA)
General Data Protection Regulation (GDPR)
Chrome Web Store Developer Program Policies
Other applicable privacy regulations


Last Updated: June 28, 2025
Version: 1.0
    
    <div class="contact">
        <h3>Contact Information</h3>
        <p><strong>Email:</strong> optimizerresume@gmail.com<br>
        <strong>Website:</strong> https://ai-career-assistant-production.up.railway.app</p>
    </div>
</body>
</html>
    `);
});
// Token Verification
app.get('/api/auth/verify', authenticateToken, async (req, res) => {
    try {
        const user = await UserAuth.findById(req.user.userId).select('-password_hash -email_verification_token -password_reset_token');

        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        res.json({
            success: true,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                emailVerified: user.email_verified,
                createdAt: user.createdAt
            }
        });

    } catch (error) {
        console.error('Token verification error:', error);
        res.status(500).json({
            success: false,
            error: 'Token verification failed'
        });
    }
});

// Email Verification
app.post('/api/auth/verify-email', async (req, res) => {
    try {
        const { token } = req.body;

        if (!token) {
            return res.status(400).json({
                success: false,
                error: 'Verification token is required'
            });
        }

        const user = await UserAuth.findOne({ email_verification_token: token });

        if (!user) {
            return res.status(400).json({
                success: false,
                error: 'Invalid or expired verification token'
            });
        }

        if (user.email_verified) {
            return res.status(400).json({
                success: false,
                error: 'Email already verified'
            });
        }

        await UserAuth.findByIdAndUpdate(user._id, {
            email_verified: true,
            email_verification_token: null
        });

        res.json({
            success: true,
            message: 'Email verified successfully! You can now log in.'
        });

    } catch (error) {
        console.error('Email verification error:', error);
        res.status(500).json({
            success: false,
            error: 'Email verification failed'
        });
    }
});

// Forgot Password
app.post('/api/auth/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                error: 'Email is required'
            });
        }

        const user = await UserAuth.findOne({ email: email.toLowerCase() });

        // Always return success to prevent email enumeration
        if (!user) {
            return res.json({
                success: true,
                message: 'If an account with this email exists, a password reset link has been sent.'
            });
        }

        // Generate password reset token (expires in 1 hour)
        const resetToken = generateToken();
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

        await UserAuth.findByIdAndUpdate(user._id, {
            password_reset_token: resetToken,
            password_reset_expires: expiresAt
        });

        res.json({
            success: true,
            message: 'If an account with this email exists, a password reset link has been sent.'
        });

    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to process password reset request'
        });
    }
});

// Logout
app.post('/api/auth/logout', authenticateToken, async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

        await UserSession.deleteOne({
            user_id: req.user.userId,
            token_hash: tokenHash
        });

        res.json({
            success: true,
            message: 'Logged out successfully'
        });

    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({
            success: false,
            error: 'Logout failed'
        });
    }
});

// Get User Profile
app.get('/api/auth/profile', authenticateToken, async (req, res) => {
    try {
        const user = await UserAuth.findById(req.user.userId).select('-password_hash -email_verification_token -password_reset_token');

        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        res.json({
            success: true,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                emailVerified: user.email_verified,
                createdAt: user.createdAt,
                lastLogin: user.last_login
            }
        });

    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get user profile'
        });
    }
});

// ====================================================================
// SUBSCRIPTION SYSTEM INITIALIZATION
// ====================================================================

const subscriptionSystem = new MongoDBSubscriptionSystem(mongoose);

// ====================================================================
// API ROUTES
// ====================================================================

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        service: 'ai-interview-subscription-api',
        version: '1.0.0',
        environment: process.env.NODE_ENV || 'development',
        database: 'connected',
        database_type: 'MongoDB',
        stripe: process.env.STRIPE_SECRET_KEY ? 'configured' : 'not configured'
    });
});

// Get subscription plans
app.get('/api/plans', (req, res) => {
    try {
        const result = subscriptionSystem.getPlans();
        res.json(result);
    } catch (error) {
        console.error('❌ Failed to get plans:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to retrieve plans',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Create Stripe checkout session
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { planId, userId, successUrl, cancelUrl } = req.body;
        
        // Validate required fields
        if (!planId || !userId || !successUrl || !cancelUrl) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields',
                required: ['planId', 'userId', 'successUrl', 'cancelUrl']
            });
        }
        
        console.log('📝 Creating checkout session:', { planId, userId });
        
        const result = await subscriptionSystem.createCheckoutSession(
            planId, 
            userId, 
            successUrl, 
            cancelUrl
        );
        
        res.json(result);
        
    } catch (error) {
        console.error('❌ Checkout session creation failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create checkout session',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Verify payment and activate subscription
app.post('/api/verify-payment', async (req, res) => {
    try {
        const { sessionId, userId } = req.body;
        
        if (!sessionId) {
            return res.status(400).json({
                success: false,
                error: 'Session ID is required'
            });
        }
        
        console.log('🔍 Verifying payment for session:', sessionId);
        
        const result = await subscriptionSystem.verifyPayment(sessionId, userId);
        res.json(result);
        
    } catch (error) {
        console.error('❌ Payment verification failed:', error);
        res.status(500).json({
            success: false,
            error: 'Payment verification failed',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Get subscription status
app.get('/api/subscription-status/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'User ID is required'
            });
        }
        
        console.log('📊 Checking subscription status for user:', userId);
        
        const result = await subscriptionSystem.getSubscriptionStatus(userId);
        res.json(result);
        
    } catch (error) {
        console.error('❌ Subscription status check failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to check subscription status',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Start trial
app.post('/api/start-trial', async (req, res) => {
    try {
        const { userId, userEmail } = req.body;  // ✅ GET BOTH ID AND EMAIL
        
        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'User ID is required'
            });
        }
        
        // ✅ CHECK FOR EMAIL TO PREVENT DUPLICATE KEY ERROR
        if (!userEmail) {
            return res.status(400).json({
                success: false,
                error: 'User email is required for trial. Please login with your email address.'
            });
        }
        
        console.log('🎯 Starting trial for user:', userId, userEmail);
        
        // ✅ PASS BOTH ID AND EMAIL TO SUBSCRIPTION SYSTEM
        const result = await subscriptionSystem.startTrial(userId, userEmail);
        res.json(result);
        
    } catch (error) {
        console.error('❌ Trial start failed:', error);
        
        // ✅ BETTER ERROR HANDLING FOR DUPLICATE KEY ERRORS
        if (error.message.includes('duplicate key') || error.message.includes('E11000')) {
            res.status(400).json({
                success: false,
                error: 'Account conflict detected. Please logout and login again with your email.'
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to start trial',
                details: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    }
});
// Cancel subscription
app.post('/api/cancel-subscription', async (req, res) => {
    try {
        const { subscriptionId, userId, reason } = req.body;
        
        if (!subscriptionId || !userId) {
            return res.status(400).json({
                success: false,
                error: 'Subscription ID and User ID are required'
            });
        }
        
        console.log('🚫 Cancelling subscription:', subscriptionId);
        
        const result = await subscriptionSystem.cancelSubscription(
            subscriptionId, 
            userId, 
            reason || 'User requested'
        );
        
        res.json(result);
        
    } catch (error) {
        console.error('❌ Subscription cancellation failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to cancel subscription',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Update usage tracking
app.post('/api/update-usage', async (req, res) => {
    try {
        const { userId, action, metadata } = req.body;
        
        if (!userId || !action) {
            return res.status(400).json({
                success: false,
                error: 'User ID and action are required'
            });
        }
        
        const result = await subscriptionSystem.updateUsage(userId, action, metadata || {});
        res.json(result);
        
    } catch (error) {
        console.error('❌ Usage update failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update usage',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});
// ====================================================================
// 🚀 SUBSCRIPTION MANAGEMENT ENDPOINTS
// ====================================================================
// Add these endpoints to your existing server.js file

// Get complete subscription management data
app.get('/api/subscription/manage/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'User ID is required'
            });
        }

        console.log('📊 Getting subscription management data for user:', userId);

        // Get subscription status
        const subscriptionData = await subscriptionSystem.getSubscriptionStatus(userId);
        
        // Get usage count for current month
        const usageCount = await subscriptionSystem.getUsageCount(userId);
        
        // Get available plans for comparison
        const plansData = subscriptionSystem.getPlans();
        
        // Get billing history (simple version)
        const payments = await Payment.find({ user_id: userId })
            .sort({ createdAt: -1 })
            .limit(5)
            .select('amount currency status plan_id createdAt');

        // Calculate next billing date (if active subscription)
        let nextBillingDate = null;
        if (subscriptionData.subscription?.status === 'active') {
            const subscription = await Subscription.findOne({ 
                user_id: userId, 
                status: 'active' 
            });
            if (subscription) {
                nextBillingDate = subscription.current_period_end;
            }
        }

        // Determine plan limits
        const currentPlan = subscriptionData.subscription?.planId;
        const planLimits = {
            trial: { responses: 10, name: 'Trial' },
            monthly: { responses: 500, name: 'Monthly Pro' },
            quarterly: { responses: 500, name: 'Quarterly Pro' },
            yearly: { responses: 500, name: 'Yearly Pro' }
        };

        const currentLimits = planLimits[currentPlan] || planLimits.trial;

        res.json({
            success: true,
            data: {
                // Current subscription info
                subscription: {
                    status: subscriptionData.subscription?.status || 'trial',
                    plan: currentPlan || 'trial',
                    planName: currentLimits.name,
                    nextBillingDate: nextBillingDate,
                    expiryDate: subscriptionData.subscription?.expiryDate,
                    features: subscriptionData.subscription?.features || ['Limited AI responses']
                },
                
                // Usage information
                usage: {
                    responses: usageCount,
                    limit: currentLimits.responses,
                    percentage: Math.round((usageCount / currentLimits.responses) * 100)
                },
                
                // Available plans for upgrades
                availablePlans: plansData.plans,
                
                // Recent billing history
                recentPayments: payments.map(payment => ({
                    amount: payment.amount / 100, // Convert cents to dollars
                    currency: payment.currency,
                    status: payment.status,
                    plan: payment.plan_id,
                    date: payment.createdAt
                }))
            }
        });

    } catch (error) {
        console.error('❌ Subscription management data fetch failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch subscription data',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Handle subscription changes (upgrade/cancel)
app.post('/api/subscription/change', async (req, res) => {
    try {
        const { userId, action, planId, reason } = req.body;
        
        if (!userId || !action) {
            return res.status(400).json({
                success: false,
                error: 'User ID and action are required'
            });
        }

        console.log('🔄 Processing subscription change:', { userId, action, planId });

        let result;

        switch (action) {
            case 'upgrade':
                if (!planId) {
                    return res.status(400).json({
                        success: false,
                        error: 'Plan ID is required for upgrade'
                    });
                }

                // Create new checkout session for upgrade
                result = await subscriptionSystem.createCheckoutSession(
                    planId,
                    userId,
                    `${process.env.BASE_URL}/subscription-success`,
                    `${process.env.BASE_URL}/subscription-cancel`
                );

                res.json({
                    success: true,
                    action: 'upgrade',
                    checkoutUrl: result.checkout_url,
                    sessionId: result.session_id
                });
                break;

            case 'cancel':
                // Find current active subscription
                const activeSubscription = await Subscription.findOne({
                    user_id: userId,
                    status: 'active'
                });

                if (!activeSubscription) {
                    return res.status(404).json({
                        success: false,
                        error: 'No active subscription found'
                    });
                }

                result = await subscriptionSystem.cancelSubscription(
                    activeSubscription._id,
                    userId,
                    reason || 'User requested cancellation'
                );

                res.json({
                    success: true,
                    action: 'cancel',
                    message: 'Subscription cancelled successfully',
                    accessUntil: result.cancellation.access_until
                });
                break;

            case 'reactivate':
                // Create checkout session for reactivation
                const lastSubscription = await Subscription.findOne({
                    user_id: userId,
                    status: 'cancelled'
                }).sort({ createdAt: -1 });

                if (!lastSubscription) {
                    return res.status(404).json({
                        success: false,
                        error: 'No cancelled subscription found'
                    });
                }

                result = await subscriptionSystem.createCheckoutSession(
                    lastSubscription.plan_id,
                    userId,
                    `${process.env.BASE_URL}/subscription-success`,
                    `${process.env.BASE_URL}/subscription-cancel`
                );

                res.json({
                    success: true,
                    action: 'reactivate',
                    checkoutUrl: result.checkout_url,
                    sessionId: result.session_id
                });
                break;

            default:
                return res.status(400).json({
                    success: false,
                    error: 'Invalid action. Supported actions: upgrade, cancel, reactivate'
                });
        }

    } catch (error) {
        console.error('❌ Subscription change failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to process subscription change',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Generate Stripe Customer Portal link (for advanced billing management)
app.post('/api/subscription/portal', async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'User ID is required'
            });
        }

        // Find user's Stripe customer ID
        const user = await User.findById(userId);
        
        if (!user || !user.stripe_customer_id) {
            return res.status(404).json({
                success: false,
                error: 'No Stripe customer found for this user'
            });
        }

        // Create Stripe portal session
        const portalSession = await stripe.billingPortal.sessions.create({
            customer: user.stripe_customer_id,
            return_url: `${process.env.BASE_URL}/dashboard.html`,
        });

        res.json({
            success: true,
            portalUrl: portalSession.url
        });

    } catch (error) {
        console.error('❌ Portal session creation failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create billing portal session',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});
// Get user analytics
app.get('/api/analytics/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'User ID is required'
            });
        }
        
        const result = await subscriptionSystem.getUserAnalytics(userId);
        res.json(result);
        
    } catch (error) {
        console.error('❌ Analytics fetch failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch analytics',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// ====================================================================
// DEBUG ENDPOINT - MONGODB VERSION
// ====================================================================

// Debug endpoint to view all data (development only) - MongoDB version
app.get('/api/debug/data', async (req, res) => {
    if (process.env.NODE_ENV !== 'development') {
        return res.status(403).json({ error: 'Debug disabled in production' });
    }
    
    try {
        const users = await UserAuth.find({}).select('-password_hash -email_verification_token -password_reset_token').limit(10);
        const sessions = await UserSession.find({}).limit(10);
        const subscriptions = await Subscription.find({}).limit(10);
        const usageLogs = await UsageLog.find({}).limit(10);
        const payments = await Payment.find({}).limit(10);

        res.json({
            database_info: {
                type: 'MongoDB',
                status: 'connected',
                connection: MONGODB_URI.replace(/\/\/.*@/, '//***:***@'), // Hide credentials
                collections_found: 5
            },
            data: {
                users,
                sessions,
                subscriptions,
                usage_logs: usageLogs,
                payments
            }
        });
    } catch (error) {
        res.status(500).json({ 
            error: error.message,
            database_info: {
                type: 'MongoDB',
                status: 'error'
            }
        });
    }
});

// ====================================================================
// STRIPE WEBHOOK HANDLING
// ====================================================================

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

app.post('/api/webhooks/stripe', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    
    if (!webhookSecret) {
        console.log('⚠️ Stripe webhook secret not configured - skipping webhook handling');
        return res.status(200).json({ 
            received: true, 
            message: 'Webhook secret not configured' 
        });
    }
    
    let event;
    
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
        console.log('🔔 Stripe webhook received:', event.type);
    } catch (err) {
        console.error('❌ Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    // Handle different event types
    try {
        switch (event.type) {
            case 'checkout.session.completed':
                console.log('✅ Checkout completed:', event.data.object.id);
                // Additional webhook handling can be added here
                break;
                
            case 'customer.subscription.updated':
                console.log('🔄 Subscription updated:', event.data.object.id);
                // Handle subscription updates
                break;
                
            case 'customer.subscription.deleted':
                console.log('🗑️ Subscription deleted:', event.data.object.id);
                // Handle subscription cancellations
                break;
                
            case 'invoice.payment_succeeded':
                console.log('💰 Payment succeeded:', event.data.object.id);
                // Handle successful payments
                break;
                
            case 'invoice.payment_failed':
                console.log('❌ Payment failed:', event.data.object.id);
                // Handle failed payments
                break;
                
            default:
                console.log(`ℹ️ Unhandled event type: ${event.type}`);
        }
        
        res.json({ 
            received: true, 
            event_type: event.type,
            processed: true
        });
        
    } catch (error) {
        console.error('❌ Webhook handler error:', error);
        res.status(500).json({ 
            success: false,
            error: 'Webhook handler failed',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// ====================================================================
// ERROR HANDLING
// ====================================================================

// Global error handler
app.use((err, req, res, next) => {
    console.error('🚨 Global error:', err);
    
    // Don't expose error details in production
    const isDevelopment = process.env.NODE_ENV === 'development';
    
    res.status(err.status || 500).json({
        success: false,
        error: 'Internal server error',
        message: isDevelopment ? err.message : 'Something went wrong',
        ...(isDevelopment && { stack: err.stack })
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Not found',
        message: 'The requested endpoint does not exist',
       available_endpoints: [
    'GET /api/health',
    'GET /api/plans',
    'POST /api/create-checkout-session',
    'POST /api/verify-payment',
    'GET /api/subscription-status/:userId',
    'POST /api/start-trial',
    'POST /api/cancel-subscription',
    'POST /api/update-usage',
    'GET /api/analytics/:userId',
    'POST /api/webhooks/stripe',
    'POST /api/auth/signup',
    'POST /api/auth/login',
    'POST /api/auth/logout',
    'GET /api/auth/profile',
    'GET /api/auth/verify',
    'POST /api/auth/verify-email',
    'POST /api/auth/forgot-password',
    'GET /api/debug/data',
    'POST /api/ai/generate-response',        // ADD THIS
    'POST /api/ai/contextual-response',      // ADD THIS  
    'GET /api/ai/health'                     // ADD THIS
]
    });
});
// ====================================================================
// 🔧 USER SETTINGS BACKEND ENDPOINTS
// Add these to your server.js file after your existing endpoints
// ====================================================================

// ====================================================================
// USER PROFILE & SETTINGS ENDPOINTS
// ====================================================================

// Get user profile with settings
app.get('/api/user/profile/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'User ID is required'
            });
        }

        // Get user from auth collection
        const user = await UserAuth.findById(userId).select('-password_hash -email_verification_token -password_reset_token');
        
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        // Get user settings (create if doesn't exist)
        let userSettings = await UserSettings.findOne({ user_id: userId });
        
        if (!userSettings) {
            // Create default settings
            userSettings = new UserSettings({
                user_id: userId,
                preferences: {
                    emailNotifications: true,
                    interviewReminders: true,
                    responseSpeed: 'balanced',
                    suggestionStyle: 'detailed'
                },
                privacy: {
                    usageAnalytics: true,
                    marketingEmails: false
                }
            });
            await userSettings.save();
        }

        res.json({
            success: true,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                emailVerified: user.email_verified,
                createdAt: user.createdAt,
                lastLogin: user.last_login,
                profile: userSettings.profile || {},
                preferences: userSettings.preferences || {},
                privacy: userSettings.privacy || {}
            }
        });

    } catch (error) {
        console.error('❌ Profile fetch failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch user profile',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Update user profile information
app.put('/api/user/profile/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { firstName, lastName, email, jobTitle, company, industry, bio } = req.body;
        
        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'User ID is required'
            });
        }

        // Update user basic info
        const fullName = `${firstName || ''} ${lastName || ''}`.trim();
        
        const updatedUser = await UserAuth.findByIdAndUpdate(
            userId,
            {
                name: fullName,
                email: email
            },
            { new: true, runValidators: true }
        ).select('-password_hash -email_verification_token -password_reset_token');

        if (!updatedUser) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        // Update or create user settings with profile info
        const profileData = {
            jobTitle: jobTitle || '',
            company: company || '',
            industry: industry || '',
            bio: bio || ''
        };

        await UserSettings.findOneAndUpdate(
            { user_id: userId },
            { 
                $set: { 
                    profile: profileData,
                    updated_at: new Date()
                }
            },
            { upsert: true, new: true }
        );

        res.json({
            success: true,
            message: 'Profile updated successfully',
            user: {
                id: updatedUser._id,
                name: updatedUser.name,
                email: updatedUser.email,
                profile: profileData
            }
        });

    } catch (error) {
        console.error('❌ Profile update failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update profile',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Update user preferences
app.put('/api/user/preferences/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { emailNotifications, interviewReminders, responseSpeed, suggestionStyle } = req.body;
        
        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'User ID is required'
            });
        }

        const preferencesData = {
            emailNotifications: emailNotifications !== undefined ? emailNotifications : true,
            interviewReminders: interviewReminders !== undefined ? interviewReminders : true,
            responseSpeed: responseSpeed || 'balanced',
            suggestionStyle: suggestionStyle || 'detailed'
        };

        await UserSettings.findOneAndUpdate(
            { user_id: userId },
            { 
                $set: { 
                    preferences: preferencesData,
                    updated_at: new Date()
                }
            },
            { upsert: true, new: true }
        );

        res.json({
            success: true,
            message: 'Preferences updated successfully',
            preferences: preferencesData
        });

    } catch (error) {
        console.error('❌ Preferences update failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update preferences',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Update privacy settings
app.put('/api/user/privacy/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { usageAnalytics, marketingEmails } = req.body;
        
        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'User ID is required'
            });
        }

        const privacyData = {
            usageAnalytics: usageAnalytics !== undefined ? usageAnalytics : true,
            marketingEmails: marketingEmails !== undefined ? marketingEmails : false
        };

        await UserSettings.findOneAndUpdate(
            { user_id: userId },
            { 
                $set: { 
                    privacy: privacyData,
                    updated_at: new Date()
                }
            },
            { upsert: true, new: true }
        );

        res.json({
            success: true,
            message: 'Privacy settings updated successfully',
            privacy: privacyData
        });

    } catch (error) {
        console.error('❌ Privacy settings update failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update privacy settings',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Change user password
app.put('/api/user/password/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { currentPassword, newPassword } = req.body;
        
        if (!userId || !currentPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                error: 'User ID, current password, and new password are required'
            });
        }

        // Get user with password
        const user = await UserAuth.findById(userId);
        
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        // Verify current password
        const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password_hash);
        
        if (!isCurrentPasswordValid) {
            return res.status(400).json({
                success: false,
                error: 'Current password is incorrect'
            });
        }

        // Hash new password
        const saltRounds = 12;
        const newPasswordHash = await bcrypt.hash(newPassword, saltRounds);

        // Update password
        await UserAuth.findByIdAndUpdate(userId, {
            password_hash: newPasswordHash,
            updated_at: new Date()
        });

        res.json({
            success: true,
            message: 'Password updated successfully'
        });

    } catch (error) {
        console.error('❌ Password update failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update password',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Submit support ticket
app.post('/api/user/support', async (req, res) => {
    try {
        const { userId, subject, category, message } = req.body;
        
        if (!userId || !subject || !message) {
            return res.status(400).json({
                success: false,
                error: 'User ID, subject, and message are required'
            });
        }

        // Create support ticket
        const supportTicket = new SupportTicket({
            user_id: userId,
            subject: subject,
            category: category || 'other',
            message: message,
            status: 'open',
            priority: 'normal'
        });

        await supportTicket.save();

        // Here you would typically send an email notification
        // to your support team and/or the user

        res.json({
            success: true,
            message: 'Support ticket submitted successfully',
            ticketId: supportTicket._id
        });

    } catch (error) {
        console.error('❌ Support ticket creation failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to submit support ticket',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Delete user account
app.delete('/api/user/account/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { confirmPassword } = req.body;
        
        if (!userId || !confirmPassword) {
            return res.status(400).json({
                success: false,
                error: 'User ID and password confirmation are required'
            });
        }

        // Get user and verify password
        const user = await UserAuth.findById(userId);
        
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        // Verify password
        const isPasswordValid = await bcrypt.compare(confirmPassword, user.password_hash);
        
        if (!isPasswordValid) {
            return res.status(400).json({
                success: false,
                error: 'Password confirmation is incorrect'
            });
        }

        // Delete all user data
        await Promise.all([
            UserAuth.findByIdAndDelete(userId),
            UserSettings.deleteMany({ user_id: userId }),
            UserSession.deleteMany({ user_id: userId }),
            Subscription.deleteMany({ user_id: userId }),
            UsageLog.deleteMany({ user_id: userId }),
            Payment.deleteMany({ user_id: userId }),
            SupportTicket.deleteMany({ user_id: userId })
        ]);

        res.json({
            success: true,
            message: 'Account deleted successfully'
        });

    } catch (error) {
        console.error('❌ Account deletion failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete account',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// ====================================================================
// MONGODB SCHEMAS FOR USER SETTINGS
// Add these schemas to your existing schema section
// ====================================================================

// User Settings Schema
const userSettingsSchema = new mongoose.Schema({
    user_id: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'UserAuth', unique: true },
    profile: {
        jobTitle: { type: String, default: '' },
        company: { type: String, default: '' },
        industry: { type: String, default: '' },
        bio: { type: String, default: '' }
    },
    preferences: {
        emailNotifications: { type: Boolean, default: true },
        interviewReminders: { type: Boolean, default: true },
        responseSpeed: { type: String, enum: ['fast', 'balanced', 'detailed'], default: 'balanced' },
        suggestionStyle: { type: String, enum: ['concise', 'detailed', 'bullet-points'], default: 'detailed' }
    },
    privacy: {
        usageAnalytics: { type: Boolean, default: true },
        marketingEmails: { type: Boolean, default: false }
    }
}, { timestamps: true });

// Support Ticket Schema
const supportTicketSchema = new mongoose.Schema({
    user_id: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'UserAuth' },
    subject: { type: String, required: true },
    category: { type: String, enum: ['technical', 'billing', 'feature', 'bug', 'other'], default: 'other' },
    message: { type: String, required: true },
    status: { type: String, enum: ['open', 'in-progress', 'resolved', 'closed'], default: 'open' },
    priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
    admin_response: { type: String },
    resolved_at: { type: Date }
}, { timestamps: true });

// Create the models (add these lines after your existing models)
const UserSettings = mongoose.model('UserSettings', userSettingsSchema);
const SupportTicket = mongoose.model('SupportTicket', supportTicketSchema);
// ====================================================================
// SERVER STARTUP AND SHUTDOWN
// ====================================================================

// Graceful shutdown handlers
const gracefulShutdown = (signal) => {
    console.log(`📴 ${signal} received, shutting down gracefully...`);
    
    mongoose.connection.close(() => {
        console.log('📊 MongoDB connection closed');
        process.exit(0);
    });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Validate required environment variables
const requiredEnvVars = [
    'STRIPE_SECRET_KEY',
    'STRIPE_PUBLIC_KEY',
    'STRIPE_PRICE_MONTHLY',
    'STRIPE_PRICE_QUARTERLY', 
    'STRIPE_PRICE_YEARLY'
];

const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
    console.error('❌ Missing required environment variables:', missingEnvVars);
    console.error('💡 Please check your .env file and ensure these variables are set:');
    missingEnvVars.forEach(varName => {
        console.error(`   - ${varName}`);
    });
    console.error('\n🔗 Setup guide:');
    console.error('   1. Get Stripe keys: https://dashboard.stripe.com/test/apikeys');
    console.error('   2. Create products: https://dashboard.stripe.com/test/products');
    console.error('   3. Copy Price IDs to .env file');
    process.exit(1);
}

// Start server
const server = app.listen(PORT, () => {
    console.log('\n🎉 ===============================================');
    console.log('🚀 AI Interview Assistant Backend Server Started!');
    console.log('===============================================');
    console.log(`📡 Server running on: http://localhost:${PORT}`);
    console.log(`📊 Database: MongoDB (${MONGODB_URI})`);
    console.log(`💳 Stripe Secret: ${process.env.STRIPE_SECRET_KEY ? 'Configured ✅' : 'Not configured ❌'}`);
    console.log(`🔑 Stripe Public: ${process.env.STRIPE_PUBLIC_KEY ? 'Configured ✅' : 'Not configured ❌'}`);
    console.log(`🔔 Webhooks: ${process.env.STRIPE_WEBHOOK_SECRET ? 'Configured ✅' : 'Optional for testing ⚠️'}`);
    console.log(`🔐 JWT Secret: ${process.env.JWT_SECRET ? 'Configured ✅' : 'Using fallback ⚠️'}`);
    console.log(`📧 Email Service: ${process.env.EMAIL_USER ? 'Configured ✅' : 'Not configured ❌'}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/api/health`);
    console.log(`🔐 Authentication: http://localhost:${PORT}/auth.html`);
    console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard.html`);
    console.log(`🔍 Debug data: http://localhost:${PORT}/api/debug/data`);
    console.log('===============================================\n');
    
    // Test MongoDB connection by counting documents
    UserAuth.countDocuments()
        .then(count => {
            console.log(`🔐 Authentication ready - Auth Users: ${count}`);
        })
        .catch(err => {
            console.error('❌ Authentication database test failed:', err);
        });

    User.countDocuments()
        .then(count => {
            console.log(`📊 Subscription system ready - Subscription Users: ${count}`);
        })
        .catch(err => {
            console.error('❌ Subscription database test failed:', err);
        });
});

// Handle server startup errors
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} is already in use`);
        console.error('💡 Try using a different port or stop the process using this port');
    } else {
        console.error('❌ Server startup error:', err);
    }
    process.exit(1);
});

module.exports = app;
// CORS fix deployment - 2025-06-29 10:51:52
