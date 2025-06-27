// ====================================================================
// SUBSCRIPTION SYSTEM MODULE
// AI Interview Assistant - Complete Subscription Management
// ====================================================================

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { v4: uuidv4 } = require('uuid');

class SubscriptionSystem {
    constructor(database) {
        this.db = database;
        this.plans = {
            monthly: {
                id: 'monthly_plan',
                name: 'Monthly',
                price: 1500, // $15.00 in cents
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
            quarterly: {
                id: 'quarterly_plan',
                name: '3 Months',
                price: 3600, // $36.00 in cents (20% discount)
                currency: 'usd',
                interval: 'month',
                interval_count: 3,
                stripe_price_id: process.env.STRIPE_PRICE_QUARTERLY,
                features: [
                    'Unlimited AI responses',
                    'Real-time interview assistance',
                    'Platform auto-detection',
                    'Response history',
                    'Priority email support',
                    'Advanced analytics'
                ]
            },
            yearly: {
                id: 'yearly_plan',
                name: 'Yearly',
                price: 12000, // $120.00 in cents (33% discount)
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

    // ====================================================================
    // HELPER FUNCTIONS
    // ====================================================================

    generateId() {
        return uuidv4();
    }

    generateSubscriptionId() {
        return `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    async logUsage(userId, action, data = {}, request = null) {
        try {
            const logData = {
                user_id: userId,
                action: action,
                data: JSON.stringify(data),
                ip_address: request ? this.getClientIP(request) : null,
                user_agent: request ? request.get('User-Agent') || null : null
            };

            return new Promise((resolve, reject) => {
                this.db.run(`
                    INSERT INTO usage_logs (user_id, action, data, ip_address, user_agent)
                    VALUES (?, ?, ?, ?, ?)
                `, [logData.user_id, logData.action, logData.data, logData.ip_address, logData.user_agent],
                function(err) {
                    if (err) {
                        console.error('❌ Usage logging failed:', err);
                        reject(err);
                    } else {
                        resolve(this.lastID);
                    }
                });
            });
        } catch (error) {
            console.error('❌ Usage logging error:', error);
        }
    }

    getClientIP(req) {
        return req.ip || 
               req.connection?.remoteAddress || 
               req.socket?.remoteAddress ||
               req.headers['x-forwarded-for']?.split(',')[0] ||
               'unknown';
    }

    async getOrCreateUser(email = null, userId = null) {
        const id = userId || this.generateId();
        
        return new Promise((resolve, reject) => {
            if (userId) {
                // Check if user exists
                this.db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
                    if (err) {
                        reject(err);
                    } else if (user) {
                        resolve(user);
                    } else {
                        // Create new user with provided ID
                        this.db.run(`
                            INSERT INTO users (id, email, created_at, updated_at)
                            VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                        `, [id, email], function(err) {
                            if (err) {
                                reject(err);
                            } else {
                                resolve({ id, email, created_at: new Date().toISOString() });
                            }
                        });
                    }
                });
            } else {
                // Create new user
                this.db.run(`
                    INSERT INTO users (id, email, created_at, updated_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `, [id, email], function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve({ id, email, created_at: new Date().toISOString() });
                    }
                });
            }
        });
    }

    // ====================================================================
    // SUBSCRIPTION PLANS
    // ====================================================================

    getPlans() {
        return {
            success: true,
            plans: Object.values(this.plans)
        };
    }

    // ====================================================================
    // CHECKOUT SESSION CREATION
    // ====================================================================

    async createCheckoutSession(planId, userId, successUrl, cancelUrl) {
        try {
            const plan = this.plans[planId];
            if (!plan) {
                throw new Error('Invalid plan selected');
            }

            console.log('🛒 Creating checkout session for plan:', planId);

            // Get or create user
            const user = await this.getOrCreateUser(null, userId);

            // Create or retrieve Stripe customer
            let customer;
            if (user.stripe_customer_id) {
                try {
                    customer = await stripe.customers.retrieve(user.stripe_customer_id);
                } catch (err) {
                    console.warn('⚠️ Stripe customer not found, creating new one');
                    customer = null;
                }
            }

            if (!customer) {
                customer = await stripe.customers.create({
                    metadata: {
                        user_id: user.id
                    }
                });

                // Update user with customer ID
                await new Promise((resolve, reject) => {
                    this.db.run('UPDATE users SET stripe_customer_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                        [customer.id, user.id], function(err) {
                            if (err) reject(err);
                            else resolve();
                        });
                });
            }

            // Validate Stripe Price ID
            if (!plan.stripe_price_id) {
                throw new Error(`Stripe Price ID not configured for plan: ${planId}. Please set STRIPE_PRICE_${planId.toUpperCase()} in environment variables.`);
            }

            // Create checkout session
            const session = await stripe.checkout.sessions.create({
                customer: customer.id,
                payment_method_types: ['card'],
                line_items: [{
                    price: plan.stripe_price_id, // Use the configured Stripe Price ID
                    quantity: 1,
                }],
                mode: 'subscription',
                success_url: successUrl,
                cancel_url: cancelUrl,
                metadata: {
                    user_id: user.id,
                    plan_id: planId
                },
                subscription_data: {
                    metadata: {
                        user_id: user.id,
                        plan_id: planId
                    }
                }
            });

            // Log checkout session creation
            await this.logUsage(user.id, 'checkout_session_created', {
                planId,
                sessionId: session.id,
                amount: plan.price
            });

            console.log('✅ Checkout session created:', session.id);

            return {
                success: true,
                sessionId: session.id,
                url: session.url
            };

        } catch (error) {
            console.error('❌ Checkout session creation failed:', error);
            throw new Error(`Checkout session creation failed: ${error.message}`);
        }
    }

    // ====================================================================
    // PAYMENT VERIFICATION
    // ====================================================================

    async verifyPayment(sessionId, userId) {
        try {
            console.log('🔍 Verifying payment for session:', sessionId);

            if (!sessionId) {
                throw new Error('Session ID is required');
            }

            // Retrieve checkout session from Stripe
            const session = await stripe.checkout.sessions.retrieve(sessionId, {
                expand: ['subscription']
            });

            if (session.payment_status !== 'paid') {
                throw new Error(`Payment not completed. Status: ${session.payment_status}`);
            }

            // Get subscription details
            const subscription = session.subscription;

            if (!subscription || subscription.status !== 'active') {
                throw new Error(`Subscription not active. Status: ${subscription?.status}`);
            }

            // Get user
            const user = await this.getOrCreateUser(null, userId || session.metadata.user_id);

            // Create subscription record
            const subscriptionId = this.generateSubscriptionId();
            const planId = session.metadata.plan_id;
            const plan = this.plans[planId];

            if (!plan) {
                throw new Error('Invalid plan in session metadata');
            }

            const subscriptionData = {
                id: subscriptionId,
                user_id: user.id,
                stripe_customer_id: session.customer,
                stripe_subscription_id: subscription.id,
                plan_id: planId,
                status: 'active',
                current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
                current_period_end: new Date(subscription.current_period_end * 1000).toISOString()
            };

            // Save subscription to database
            await new Promise((resolve, reject) => {
                this.db.run(`
                    INSERT INTO subscriptions 
                    (id, user_id, stripe_customer_id, stripe_subscription_id, plan_id, status, current_period_start, current_period_end)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    subscriptionData.id, subscriptionData.user_id, subscriptionData.stripe_customer_id,
                    subscriptionData.stripe_subscription_id, subscriptionData.plan_id, subscriptionData.status,
                    subscriptionData.current_period_start, subscriptionData.current_period_end
                ], function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                });
            });

            // Log payment
            await new Promise((resolve, reject) => {
                this.db.run(`
                    INSERT INTO payments 
                    (id, user_id, stripe_payment_intent_id, amount, currency, status, plan_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [
                    session.payment_intent, user.id, session.payment_intent,
                    plan.price, plan.currency, 'succeeded', planId
                ], function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                });
            });

            // Log subscription activation
            await this.logUsage(user.id, 'subscription_activated', {
                planId,
                subscriptionId,
                amount: plan.price,
                stripe_subscription_id: subscription.id
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
                    expiryDate: subscriptionData.current_period_end,
                    autoRenew: true,
                    features: plan.features
                }
            };

        } catch (error) {
            console.error('❌ Payment verification failed:', error);
            throw new Error(`Payment verification failed: ${error.message}`);
        }
    }

    // ====================================================================
    // SUBSCRIPTION STATUS
    // ====================================================================

    async getSubscriptionStatus(userId) {
        try {
            if (!userId) {
                throw new Error('User ID is required');
            }

            console.log('📊 Checking subscription status for user:', userId);

            // Get user's active subscription
            return new Promise((resolve, reject) => {
                this.db.get(`
                    SELECT s.*, p.name as plan_name 
                    FROM subscriptions s
                    LEFT JOIN (VALUES 
                        ('monthly_plan', 'Monthly'),
                        ('quarterly_plan', '3 Months'), 
                        ('yearly_plan', 'Yearly')
                    ) p(id, name) ON s.plan_id = p.id
                    WHERE s.user_id = ? AND s.status = 'active' 
                    ORDER BY s.created_at DESC LIMIT 1
                `, [userId], async (err, subscription) => {
                    if (err) {
                        console.error('❌ Database error:', err);
                        reject(new Error('Database error'));
                        return;
                    }

                    if (subscription) {
                        // Check if subscription is still valid
                        const expiryDate = new Date(subscription.current_period_end);
                        const now = new Date();

                        if (expiryDate > now) {
                            // Log status check
                            await this.logUsage(userId, 'subscription_status_check', {
                                status: 'active',
                                plan_id: subscription.plan_id
                            });

                            resolve({
                                success: true,
                                status: 'active',
                                subscription: {
                                    id: subscription.id,
                                    planId: subscription.plan_id,
                                    planName: subscription.plan_name || subscription.plan_id,
                                    status: subscription.status,
                                    expiryDate: subscription.current_period_end,
                                    startDate: subscription.current_period_start,
                                    daysRemaining: Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24))
                                }
                            });
                        } else {
                            // Subscription expired
                            this.db.run('UPDATE subscriptions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                                ['expired', subscription.id], async (err) => {
                                    if (!err) {
                                        await this.logUsage(userId, 'subscription_expired', {
                                            subscription_id: subscription.id,
                                            plan_id: subscription.plan_id
                                        });
                                    }
                                });

                            resolve({
                                success: true,
                                status: 'expired',
                                message: 'Subscription has expired'
                            });
                        }
                    } else {
                        // Check for trial
                        this.db.get('SELECT trial_started_at, trial_used FROM users WHERE id = ?',
                            [userId], async (err, user) => {
                                if (err) {
                                    reject(new Error('Database error'));
                                    return;
                                }

                                if (user && user.trial_started_at && !user.trial_used) {
                                    const trialStart = new Date(user.trial_started_at);
                                    const trialDuration = 5 * 60 * 1000; // 5 minutes
                                    const trialEnd = new Date(trialStart.getTime() + trialDuration);
                                    const now = new Date();

                                    if (now < trialEnd) {
                                        const minutesLeft = Math.ceil((trialEnd - now) / (1000 * 60));
                                        resolve({
                                            success: true,
                                            status: 'trial',
                                            trial: {
                                                active: true,
                                                minutesLeft: minutesLeft,
                                                endTime: trialEnd.getTime()
                                            }
                                        });
                                    } else {
                                        // Trial expired
                                        this.db.run('UPDATE users SET trial_used = TRUE WHERE id = ?', [userId]);
                                        resolve({
                                            success: true,
                                            status: 'trial_expired',
                                            message: 'Trial period has ended'
                                        });
                                    }
                                } else {
                                    resolve({
                                        success: true,
                                        status: 'inactive',
                                        message: 'No active subscription found'
                                    });
                                }
                            });
                    }
                });
            });

        } catch (error) {
            console.error('❌ Subscription status check failed:', error);
            throw new Error(`Subscription status check failed: ${error.message}`);
        }
    }

    // ====================================================================
    // TRIAL MANAGEMENT
    // ====================================================================

    async startTrial(userId) {
        try {
            if (!userId) {
                throw new Error('User ID is required');
            }

            console.log('🎯 Starting trial for user:', userId);

            // Get or create user
            const user = await this.getOrCreateUser(null, userId);

            // Check if user already used trial
            if (user.trial_used) {
                throw new Error('Trial already used');
            }

            // Check if user has active trial
            if (user.trial_started_at) {
                const trialStart = new Date(user.trial_started_at);
                const trialDuration = 5 * 60 * 1000; // 5 minutes
                const trialEnd = new Date(trialStart.getTime() + trialDuration);
                const now = new Date();

                if (now < trialEnd) {
                    const minutesLeft = Math.ceil((trialEnd - now) / (1000 * 60));
                    return {
                        success: true,
                        message: 'Trial already active',
                        trial: {
                            startTime: trialStart.getTime(),
                            duration: trialDuration,
                            endTime: trialEnd.getTime(),
                            minutesLeft: minutesLeft
                        }
                    };
                }
            }

            const now = new Date().toISOString();
            const trialDuration = 5 * 60 * 1000; // 5 minutes

            // Start trial
            await new Promise((resolve, reject) => {
                this.db.run('UPDATE users SET trial_started_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                    [now, user.id], function(err) {
                        if (err) reject(err);
                        else resolve();
                    });
            });

            // Log trial start
            await this.logUsage(user.id, 'trial_started', {
                duration: trialDuration
            });

            console.log('✅ Trial started for user:', userId);

            return {
                success: true,
                message: 'Trial started successfully',
                trial: {
                    startTime: new Date(now).getTime(),
                    duration: trialDuration,
                    endTime: new Date(now).getTime() + trialDuration,
                    minutesLeft: 5
                }
            };

        } catch (error) {
            console.error('❌ Trial start failed:', error);
            throw new Error(`Failed to start trial: ${error.message}`);
        }
    }

    // ====================================================================
    // SUBSCRIPTION CANCELLATION
    // ====================================================================

    async cancelSubscription(subscriptionId, userId, reason = 'User requested') {
        try {
            if (!subscriptionId || !userId) {
                throw new Error('Subscription ID and User ID are required');
            }

            console.log('🚫 Cancelling subscription:', subscriptionId);

            // Get subscription from database
            return new Promise((resolve, reject) => {
                this.db.get('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?',
                    [subscriptionId, userId], async (err, subscription) => {
                        if (err) {
                            reject(new Error('Database error'));
                            return;
                        }

                        if (!subscription) {
                            reject(new Error('Subscription not found'));
                            return;
                        }

                        try {
                            // Cancel subscription in Stripe (at period end)
                            await stripe.subscriptions.update(subscription.stripe_subscription_id, {
                                cancel_at_period_end: true,
                                metadata: {
                                    cancellation_reason: reason
                                }
                            });

                            // Update subscription status in database
                            this.db.run('UPDATE subscriptions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                                ['cancelled', subscriptionId], async (err) => {
                                    if (err) {
                                        reject(new Error('Failed to update subscription status'));
                                        return;
                                    }

                                    // Log cancellation
                                    await this.logUsage(userId, 'subscription_cancelled', {
                                        subscription_id: subscriptionId,
                                        reason: reason,
                                        plan_id: subscription.plan_id
                                    });

                                    console.log('✅ Subscription cancelled:', subscriptionId);

                                    resolve({
                                        success: true,
                                        message: 'Subscription cancelled successfully',
                                        details: 'Your subscription will remain active until the end of the current billing period'
                                    });
                                });

                        } catch (stripeError) {
                            console.error('❌ Stripe cancellation failed:', stripeError);
                            reject(new Error('Failed to cancel subscription with payment processor'));
                        }
                    });
            });

        } catch (error) {
            console.error('❌ Subscription cancellation failed:', error);
            throw new Error(`Subscription cancellation failed: ${error.message}`);
        }
    }

    // ====================================================================
    // USAGE TRACKING
    // ====================================================================

    async updateUsage(userId, action, metadata = {}) {
        try {
            if (!userId || !action) {
                throw new Error('User ID and action are required');
            }

            await this.logUsage(userId, action, metadata);

            return {
                success: true,
                message: 'Usage updated successfully'
            };

        } catch (error) {
            console.error('❌ Usage update failed:', error);
            throw new Error(`Usage update failed: ${error.message}`);
        }
    }

    // ====================================================================
    // ANALYTICS
    // ====================================================================

    async getUserAnalytics(userId) {
        try {
            if (!userId) {
                throw new Error('User ID is required');
            }

            return new Promise((resolve, reject) => {
                // Get user's usage statistics
                this.db.all(`
                    SELECT 
                        action,
                        COUNT(*) as count,
                        DATE(created_at) as date
                    FROM usage_logs 
                    WHERE user_id = ? 
                    AND created_at >= datetime('now', '-30 days')
                    GROUP BY action, DATE(created_at)
                    ORDER BY created_at DESC
                `, [userId], (err, usage) => {
                    if (err) {
                        reject(new Error('Database error'));
                        return;
                    }

                    // Get subscription info
                    this.db.get(`
                        SELECT s.*, p.name as plan_name
                        FROM subscriptions s
                        LEFT JOIN (VALUES 
                            ('monthly_plan', 'Monthly'),
                            ('quarterly_plan', '3 Months'), 
                            ('yearly_plan', 'Yearly')
                        ) p(id, name) ON s.plan_id = p.id
                        WHERE s.user_id = ? 
                        ORDER BY s.created_at DESC LIMIT 1
                    `, [userId], (err, subscription) => {
                        if (err) {
                            reject(new Error('Database error'));
                            return;
                        }

                        resolve({
                            success: true,
                            analytics: {
                                usage: usage,
                                subscription: subscription,
                                totalActions: usage.reduce((sum, item) => sum + item.count, 0),
                                period: '30 days'
                            }
                        });
                    });
                });
            });

        } catch (error) {
            console.error('❌ Analytics fetch failed:', error);
            throw new Error(`Analytics fetch failed: ${error.message}`);
        }
    }
}

module.exports = SubscriptionSystem;