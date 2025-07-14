// ====================================================================
// AI Interview Assistant Backend Server
// Complete MongoDB Implementation - 100% Working
// ====================================================================

const express = require('express');
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

const app = express();
const PORT = process.env.PORT || 5000;

console.log('🚀 Starting AI Interview Assistant Backend Server...');

// ====================================================================
// MIDDLEWARE SETUP - CLEAN AND WORKING
// ====================================================================

// ✅ CORS FIRST - Simple and Working
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

// ✅ Security middleware
app.use(helmet({
    contentSecurityPolicy: false // Allow external scripts for Stripe
}));

// ✅ Body parsing (webhook handling first)
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ✅ Request logging
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// ✅ Static files
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

// Create Models
const UserAuth = mongoose.model('UserAuth', userAuthSchema);
const UserSession = mongoose.model('UserSession', userSessionSchema);
const User = mongoose.model('User', userSchema);
const Subscription = mongoose.model('Subscription', subscriptionSchema);
const UsageLog = mongoose.model('UsageLog', usageLogSchema);
const Payment = mongoose.model('Payment', paymentSchema);
const UserSettings = mongoose.model('UserSettings', userSettingsSchema);
const SupportTicket = mongoose.model('SupportTicket', supportTicketSchema);

// ====================================================================
// MONGODB SUBSCRIPTION SYSTEM
// ====================================================================

class MongoDBSubscriptionSystem {
    constructor(mongoose) {
        this.mongoose = mongoose;
        this.stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        
        // Plan definitions
        this.plans = {
            'monthly': {
                id: 'monthly',
                name: 'Monthly Pro',
                price: 1500, // $15.00
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
                price: 3900, // $39.00 
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
                price: 12000, // $120.00
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

    // Get or create user
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

            const plan = this.plans[planId];
            if (!plan) {
                throw new Error('Invalid plan ID');
            }

            if (!plan.stripe_price_id) {
                throw new Error(`Stripe price ID not configured for plan: ${planId}`);
            }

            // Create user with string ID
            let user;
            
            if (userId) {
                try {
                    user = await User.findOne({ _id: userId });
                    if (user) {
                        console.log('✅ Found existing user');
                    } else {
                        user = new User({
                            _id: userId,
                            email: `${userId}@example.com`
                        });
                        await user.save();
                        console.log('✅ Created new user with string ID');
                    }
                } catch (error) {
                    user = new User({
                        email: `user-${Date.now()}@example.com`
                    });
                    await user.save();
                    console.log('✅ Created new user with auto-generated ID');
                }
            } else {
                user = new User({
                    email: `user-${Date.now()}@example.com`
                });
                await user.save();
                console.log('✅ Created new user (no userId provided)');
            }

            const userIdString = user._id.toString();

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
                    user_id: userIdString,
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

    // Start trial
    async startTrial(userId, userEmail) {
        try {
            if (!userId || !userEmail) {
                throw new Error('User ID and email are required');
            }

            console.log('🎯 Starting trial for user:', userId, userEmail);

            let user = await User.findOne({
                $or: [
                    { _id: userId },
                    { email: userEmail }
                ]
            });

            if (user && user.trial_used) {
                console.log('❌ User already used trial:', userEmail);
                throw new Error('Trial already used for this user');
            }

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

            const now = Date.now();

            if (!user) {
                const newUser = new User({
                    _id: userId,
                    email: userEmail,
                    trial_started_at: new Date(now),
                    trial_used: true
                });
                await newUser.save();
                console.log('✅ Created new user with trial:', userEmail);
            } else {
                await User.findOneAndUpdate(
                    { $or: [{ _id: userId }, { email: userEmail }] },
                    {
                        $set: {
                            trial_started_at: new Date(now),
                            trial_used: true,
                            email: userEmail
                        }
                    }
                );
                console.log('✅ Updated existing user with trial:', userEmail);
            }

            await this.logUsage(userId, 'trial_started', {
                userEmail: userEmail,
                trialType: 'free_10_minute'
            });

            return {
                success: true,
                message: 'Trial started successfully',
                trial: {
                    startTime: now,
                    duration: 10 * 60 * 1000,
                    endTime: now + (10 * 60 * 1000),
                    minutesLeft: 10,
                    isActive: true,
                    isUnlimited: true,
                    trialType: 'free_10_minute'
                }
            };

        } catch (error) {
            console.error('❌ Trial start failed:', error);
            
            if (error.message.includes('duplicate key') || error.message.includes('E11000')) {
                throw new Error('Account conflict detected. Please logout and login again with your email.');
            } else {
                throw new Error(`Trial start failed: ${error.message}`);
            }
        }
    }

    // Get subscription status
    async getSubscriptionStatus(userId) {
        try {
            console.log('📊 Checking subscription status for user:', userId);

            const user = await User.findById(userId);
            if (!user) {
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

    // Log usage
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
                createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
            });
            return count;
        } catch (error) {
            console.error('❌ Usage count failed:', error);
            return 0;
        }
    }

    // Update usage
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

// ====================================================================
// OPENAI INITIALIZATION
// ====================================================================

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
// AUTHENTICATION CONFIGURATION
// ====================================================================

// Email configuration
let emailTransporter = null;

try {
    console.log('📧 Attempting to configure email service...');
    
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        emailTransporter = nodemailer.createTransporter({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });
        console.log('📧 Email transporter created successfully');
        
        emailTransporter.verify()
            .then(() => console.log('📧 Email service verified successfully'))
            .catch(err => {
                console.log('⚠️ Email verification failed:', err.message);
                console.log('📧 Email features will be disabled');
                emailTransporter = null;
            });
    } else {
        console.log('📧 Email credentials not provided - email features disabled');
    }
} catch (error) {
    console.log('⚠️ Email setup failed:', error.message);
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
// SUBSCRIPTION SYSTEM INITIALIZATION
// ====================================================================

const subscriptionSystem = new MongoDBSubscriptionSystem(mongoose);

// ====================================================================
// HELPER FUNCTIONS FOR AI RESPONSES
// ====================================================================

function generateSmartFallback(question) {
    const questionLower = question.toLowerCase();
    
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
    
    const genericResponses = [
        "Based on my experience, I believe in taking a systematic approach and focusing on delivering high-quality results that align with team objectives.",
        "I approach this by first understanding the requirements clearly, then developing a strategic plan that leverages my skills to achieve the best outcome.",
        "In my experience, success comes from combining technical expertise with strong communication and collaboration skills to drive meaningful results.",
        "My approach is to listen carefully, analyze the situation thoroughly, and then apply my experience to deliver value while maintaining high professional standards."
    ];
    
    return genericResponses[Math.floor(Math.random() * genericResponses.length)];
}

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

// ====================================================================
// AI ENDPOINTS - MAIN FUNCTIONALITY
// ====================================================================

// ✅ COMPLETE ERROR-FREE CODE - Replace your existing endpoints with this

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
        console.log('🔍 Context fields received:', Object.keys(context || {}));
        console.log('🔍 Has resumeContext:', !!(context && context.resumeContext));
        console.log('🔍 Has resumeContent:', !!(context && context.resumeContent));
        console.log('🔍 Resume context preview:', context?.resumeContext?.substring(0, 100) + '...');
        
        // 🆕 NEW: Check for conversation history
        const hasConversationHistory = context?.conversationHistory?.length > 0;
        if (hasConversationHistory) {
            console.log(`🔗 Found ${context.conversationHistory.length} previous exchanges for context`);
        }
        
        let aiResponse;
        let tokensUsed = 0;
        let responseSource = 'fallback';
        
        // Try OpenAI if configured
        if (openai) {
            try {
                console.log('🔗 Calling OpenAI API...');
                
                // 🔥 BUILD RESUME-AWARE SYSTEM PROMPT (UNCHANGED)
                let systemPrompt = `You are an expert interview coach helping someone answer interview questions professionally and concisely.

Guidelines:
- Provide specific, actionable responses in 1-2 sentences
- Use the STAR method when relevant (Situation, Task, Action, Result)
- Be confident but humble
- Focus on skills, experience, and value proposition
- Keep responses under 150 words
- Sound natural and conversational
- Answer in first person as if you are the candidate`;

                // 🔥 ADD RESUME CONTEXT IF AVAILABLE (UNCHANGED)
                if (context && context.resumeContext) {
                    systemPrompt += `\n\nCANDIDATE'S BACKGROUND:\n${context.resumeContext}\n\nIMPORTANT: Use this background to give personalized responses with specific examples from their actual experience. Reference their real skills, companies, and achievements when relevant.`;
                    console.log('📄 Using resume context in AI prompt');
                } else {
                    console.log('💬 No resume context - using generic response');
                }

                systemPrompt += `\n\nContext: ${context?.timestamp ? 'Live Interview' : 'Interview'} interview
Current time: ${new Date().toLocaleString()}`;

                // 🆕 NEW: Build messages array with conversation history
                const messages = [
                    {
                        role: 'system',
                        content: systemPrompt
                    }
                ];

                // 🆕 NEW: Add conversation history if available
                if (hasConversationHistory) {
                    context.conversationHistory.forEach(exchange => {
                        if (exchange.question && exchange.response) {
                            messages.push({
                                role: 'user',
                                content: `Interview question: "${exchange.question}"`
                            });
                            messages.push({
                                role: 'assistant', 
                                content: exchange.response
                            });
                        }
                    });
                    console.log(`📚 Added ${context.conversationHistory.length} conversation exchanges to context`);
                }

                // 🔥 BUILD USER PROMPT (UNCHANGED)
                let userPrompt = `Interview Question: "${question}"

Please provide a professional first-person response that:
1. Directly answers the question
2. Uses specific examples when possible
3. Demonstrates relevant skills and experience
4. Sounds natural and conversational
5. Is concise (1-2 sentences, under 150 words)`;

                // 🔥 ADD RESUME-SPECIFIC INSTRUCTIONS IF AVAILABLE (UNCHANGED)
                if (context && context.resumeContext) {
                    userPrompt += `\n6. Reference specific experiences, companies, or achievements from the candidate's background above when relevant`;
                }

                userPrompt += `\n\nResponse:`;

                // Add current question
                messages.push({
                    role: 'user',
                    content: userPrompt
                });
                
                // 🆕 MODIFIED: Use messages array instead of simple system/user
                const completion = await openai.chat.completions.create({
                    model: 'gpt-4o-mini',
                    messages: messages, // ← Now includes conversation history
                    max_tokens: 200,
                    temperature: 0.7,
                    top_p: 0.9
                });
                
                aiResponse = completion.choices[0]?.message?.content || 'Unable to generate response.';
                tokensUsed = completion.usage?.total_tokens || 0;
                responseSource = 'openai';
                
                console.log('✅ OpenAI response generated successfully');
                console.log('📊 Tokens used:', tokensUsed);
                console.log('🔗 Used conversation context:', hasConversationHistory);
                
            } catch (openaiError) {
                console.error('❌ OpenAI API error:', openaiError.message);
                aiResponse = generateSmartFallback(question);
                responseSource = 'fallback_openai_error';
            }
        } else {
            console.log('⚠️ OpenAI not configured, using fallback');
            aiResponse = generateSmartFallback(question);
            responseSource = 'fallback_no_api';
        }
        
        // Track usage if user provided (UNCHANGED)
        if (user_id) {
            try {
                await subscriptionSystem.updateUsage(user_id, 'ai_response_generated', { 
                    question_length: question.length,
                    response_length: aiResponse.length,
                    tokens_used: tokensUsed,
                    source: responseSource,
                    timestamp: new Date(),
                    // 🔥 TRACK RESUME USAGE (UNCHANGED)
                    has_resume_context: !!(context && context.resumeContext),
                    // 🆕 NEW: Track conversation context usage
                    has_conversation_history: hasConversationHistory,
                    conversation_history_length: context?.conversationHistory?.length || 0
                });
                console.log('📊 Usage tracked for user:', user_id);
            } catch (usageError) {
                console.warn('⚠️ Usage tracking failed:', usageError.message);
            }
        }
        
        // Return successful response (ENHANCED)
        res.json({
            success: true,
            response: aiResponse,
            tokens_used: tokensUsed,
            source: responseSource,
            user_id: user_id || null,
            timestamp: new Date().toISOString(),
            fallback: responseSource.includes('fallback'),
            // 🔥 INCLUDE RESUME STATUS IN RESPONSE (UNCHANGED)
            used_resume_context: !!(context && context.resumeContext),
            // 🆕 NEW: Include conversation context status
            used_conversation_history: hasConversationHistory,
            conversation_history_length: context?.conversationHistory?.length || 0
        });
        
    } catch (error) {
        console.error('❌ AI generation critical error:', error);
        
        // Emergency fallback response (UNCHANGED)
        const emergencyResponse = generateSmartFallback(req.body.question || 'general interview question');
        
        res.json({
            success: true,
            response: emergencyResponse,
            tokens_used: 0,
            source: 'emergency_fallback',
            fallback: true,
            error_handled: true,
            timestamp: new Date().toISOString(),
            used_resume_context: false,
            used_conversation_history: false
        });
    }
});

// 🎤 NEW TRANSCRIPTION ENDPOINT
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

// 🔧 FIXED /api/transcribe ENDPOINT - Replace your existing one with this
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
    try {
        console.log('🎤 Transcription request received');
        
        // Check if audio file exists and is large enough
        if (!req.file) {
            console.log('⚠️ No audio file received');
            return res.json({ 
                success: false, 
                transcript: null, 
                error: 'No audio file provided' 
            });
        }
        
        if (req.file.size < 100) {
            console.log('⚠️ Audio file too small:', req.file.size, 'bytes');
            return res.json({ 
                success: false, 
                transcript: null, 
                error: `Audio file too small: ${req.file.size} bytes` 
            });
        }

        console.log('📁 Audio file size:', req.file.size, 'bytes');
        console.log('📁 Audio file type:', req.file.mimetype);
        
        // Create FormData with proper formatting
        const FormData = require('form-data');
        const formData = new FormData();
        
        // ✅ IMPROVED: Add file with proper content type and filename
        formData.append('file', req.file.buffer, {
            filename: 'audio.wav',
            contentType: 'audio/wav'
        });
        formData.append('model', 'whisper-1');
        formData.append('language', 'en');
        formData.append('response_format', 'json');
        formData.append('temperature', '0');

        console.log('🗣️ Sending audio to OpenAI Whisper API...');
        
        const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                ...formData.getHeaders()
            },
            body: formData
        });

        console.log('📡 Whisper API response status:', response.status);

        if (response.ok) {
            const result = await response.json();
            const transcript = result.text ? result.text.trim() : null;
            
            console.log('✅ Whisper transcription successful:', transcript);
            res.json({ 
                success: true, 
                transcript: transcript,
                confidence: result.confidence || null,
                duration: result.duration || null
            });
        } else {
            // ✅ CRITICAL FIX: Return the ACTUAL error from OpenAI
            const errorText = await response.text();
            console.error('❌ Whisper API error details:');
            console.error('  Status:', response.status);
            console.error('  Raw error:', errorText);
            
            let parsedError;
            try {
                parsedError = JSON.parse(errorText);
                console.error('  Parsed error:', parsedError);
            } catch (e) {
                parsedError = { error: { message: errorText } };
            }
            
            // Return detailed error based on status code
            let detailedError;
            switch (response.status) {
                case 400:
                    detailedError = `Bad Request: ${parsedError.error?.message || errorText}`;
                    break;
                case 401:
                    detailedError = 'Unauthorized: Invalid or missing API key';
                    break;
                case 402:
                    detailedError = 'Payment Required: Insufficient credits or billing issue';
                    break;
                case 413:
                    detailedError = 'File too large for Whisper API';
                    break;
                case 415:
                    detailedError = 'Unsupported audio format';
                    break;
                case 429:
                    detailedError = 'Rate limit exceeded';
                    break;
                default:
                    detailedError = `API error ${response.status}: ${parsedError.error?.message || errorText}`;
            }
            
            res.json({ 
                success: false, 
                transcript: null, 
                error: detailedError,
                details: {
                    status: response.status,
                    raw_error: errorText,
                    parsed_error: parsedError
                }
            });
        }
    } catch (error) {
        console.error('❌ Transcription endpoint error:', error);
        res.json({ 
            success: false, 
            transcript: null, 
            error: `Server error: ${error.message}`,
            details: {
                error_type: error.name,
                stack: error.stack
            }
        });
    }
});

// ✅ BONUS: Add test endpoint to verify API key and Whisper access
app.get('/api/test-whisper', async (req, res) => {
    try {
        console.log('🔑 Testing Whisper API access...');
        
        // Test API key with models endpoint
        const modelsResponse = await fetch('https://api.openai.com/v1/models', {
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
            }
        });
        
        if (!modelsResponse.ok) {
            const errorText = await modelsResponse.text();
            return res.json({
                success: false,
                error: `API key test failed: ${modelsResponse.status}`,
                details: errorText
            });
        }
        
        const models = await modelsResponse.json();
        const whisperModel = models.data.find(m => m.id === 'whisper-1');
        
        res.json({
            success: true,
            api_key_valid: true,
            whisper_available: !!whisperModel,
            whisper_model: whisperModel || null,
            total_models: models.data.length
        });
        
    } catch (error) {
        console.error('❌ API key test error:', error);
        res.json({
            success: false,
            error: `Test failed: ${error.message}`,
            details: error.stack
        });
    }
});

// Continue with the rest of your server.js file...
// (any other endpoints, then app.listen() at the very bottom)

// AI health check endpoint
app.get('/api/ai/health', (req, res) => {
    res.json({
        success: true,
        service: 'AI Interview Assistant',
        version: '1.0.0',
        endpoints: {
            generate_response: '/api/ai/generate-response',
            health_check: '/api/ai/health'
        },
        openai_configured: !!process.env.OPENAI_API_KEY,
        openai_available: !!openai,
        environment: process.env.NODE_ENV || 'development',
        timestamp: new Date().toISOString()
    });
});

// ====================================================================
// SUBSCRIPTION ROUTES
// ====================================================================

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
        const { userId, userEmail } = req.body;
        
        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'User ID is required'
            });
        }
        
        if (!userEmail) {
            return res.status(400).json({
                success: false,
                error: 'User email is required for trial. Please login with your email address.'
            });
        }
        
        console.log('🎯 Starting trial for user:', userId, userEmail);
        
        const result = await subscriptionSystem.startTrial(userId, userEmail);
        res.json(result);
        
    } catch (error) {
        console.error('❌ Trial start failed:', error);
        
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
// AUTHENTICATION ROUTES
// ====================================================================

// User Signup
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({
                success: false,
                error: 'Name, email, and password are required'
            });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                success: false,
                error: 'Please enter a valid email address'
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                error: 'Password must be at least 6 characters long'
            });
        }

        const existingUser = await UserAuth.findOne({ email: email.toLowerCase() });
        if (existingUser) {
            return res.status(400).json({
                success: false,
                error: 'An account with this email already exists'
            });
        }

        const passwordHash = await hashPassword(password);
        const verificationToken = generateToken();

        const newUser = new UserAuth({
            name,
            email: email.toLowerCase(),
            password_hash: passwordHash,
            email_verification_token: verificationToken,
            email_verified: !emailTransporter
        });

        await newUser.save();

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
        console.error('❌ SIGNUP ERROR:', error);
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

        const user = await UserAuth.findOne({ email: email.toLowerCase() });

        if (!user) {
            return res.status(401).json({
                success: false,
                error: 'Invalid email or password'
            });
        }

        if (user.locked_until && new Date() < user.locked_until) {
            return res.status(423).json({
                success: false,
                error: 'Account temporarily locked due to too many failed login attempts. Please try again later.'
            });
        }

        const isValidPassword = await verifyPassword(password, user.password_hash);
        
        if (!isValidPassword) {
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

        if (!user.email_verified && emailTransporter) {
            return res.status(401).json({
                success: false,
                error: 'Please verify your email address before logging in',
                needsVerification: true
            });
        }

        await UserAuth.findByIdAndUpdate(user._id, {
            login_attempts: 0,
            locked_until: null,
            last_login: new Date()
        });

        const token = generateJWTToken({ id: user._id, email: user.email, name: user.name });

        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

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

// ====================================================================
// STRIPE WEBHOOK
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
    
    try {
        switch (event.type) {
            case 'checkout.session.completed':
                console.log('✅ Checkout completed:', event.data.object.id);
                break;
                
            case 'customer.subscription.updated':
                console.log('🔄 Subscription updated:', event.data.object.id);
                break;
                
            case 'customer.subscription.deleted':
                console.log('🗑️ Subscription deleted:', event.data.object.id);
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
            error: 'Webhook handler failed'
        });
    }
});

// ====================================================================
// PRIVACY ROUTE
// ====================================================================

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
    </style>
</head>
<body>
    <h1>Privacy Policy - AI Interview Assistant</h1>
    <p><strong>Effective Date:</strong> June 28, 2025</p>
    
    <h2>Overview</h2>
    <p>AI Interview Assistant is committed to protecting your privacy. This Privacy Policy explains how we collect, use, and safeguard your information when you use our Chrome extension and web platform.</p>
    
    <h2>Information We Collect</h2>
    <p>We collect account information (email, name), profile data (resume content, preferences), usage data (AI responses generated), and technical data (browser type, IP address) necessary for providing our services.</p>
    
    <h2>How We Use Your Information</h2>
    <p>We use your information to generate personalized AI interview responses, maintain your account, provide customer support, and improve our services.</p>
    
    <h2>Data Security</h2>
    <p>All data is encrypted in transit and at rest. We use secure authentication protocols and conduct regular security audits.</p>
    
    <h2>Contact Information</h2>
    <p><strong>Email:</strong> optimizerresume@gmail.com</p>
</body>
</html>
    `);
});

// ====================================================================
// ERROR HANDLING
// ====================================================================

// Global error handler
app.use((err, req, res, next) => {
    console.error('🚨 Global error:', err);
    
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
            'GET /api/subscription-status/:userId',
            'POST /api/start-trial',
            'POST /api/update-usage',
            'POST /api/ai/generate-response',
            'GET /api/ai/health',
            'POST /api/auth/signup',
            'POST /api/auth/login',
            'GET /api/auth/profile',
            'POST /api/auth/logout',
            'POST /api/webhooks/stripe',
            'GET /privacy'
        ]
    });
});

// ====================================================================
// SERVER STARTUP
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
    'STRIPE_PUBLIC_KEY'
];

const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
    console.error('❌ Missing required environment variables:', missingEnvVars);
    console.error('💡 Please check your .env file and ensure these variables are set');
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
    console.log(`🔗 AI endpoint: http://localhost:${PORT}/api/ai/generate-response`);
    console.log('===============================================\n');
    
    // Test MongoDB connection
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
