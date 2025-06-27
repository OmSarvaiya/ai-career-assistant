#!/usr/bin/env node

// ====================================================================
// 🚀 FIXED PRE-LAUNCH TESTING SCRIPT
// ====================================================================
// Run this script before going live to validate all systems
// Usage: node pre-launch-test.js

require('dotenv').config();
const https = require('https');
const http = require('http');
const mongoose = require('mongoose');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Test Configuration
const CONFIG = {
    BASE_URL: process.env.BASE_URL || 'http://localhost:5000',
    MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/ai-interview-assistant',
    TIMEOUT: 10000,
    TEST_USER_EMAIL: 'test-user@example.com',
    TEST_USER_ID: '507f1f77bcf86cd799439011' // Valid MongoDB ObjectId
};

// Colors for console output
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m'
};

// Test results tracking
let testResults = {
    passed: 0,
    failed: 0,
    warnings: 0,
    critical: 0,
    details: []
};

// ====================================================================
// UTILITY FUNCTIONS
// ====================================================================

function log(level, message, details = null) {
    const timestamp = new Date().toISOString();
    const color = {
        'PASS': colors.green,
        'FAIL': colors.red,
        'WARN': colors.yellow,
        'INFO': colors.blue,
        'CRITICAL': colors.magenta
    }[level] || colors.white;

    console.log(`${color}[${level}]${colors.reset} ${timestamp} - ${message}`);
    
    if (details) {
        console.log(`${colors.cyan}Details:${colors.reset}`, details);
    }

    testResults.details.push({
        level,
        message,
        details,
        timestamp
    });

    switch(level) {
        case 'PASS': testResults.passed++; break;
        case 'FAIL': testResults.failed++; break;
        case 'WARN': testResults.warnings++; break;
        case 'CRITICAL': testResults.critical++; break;
    }
}

function makeRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const isHttps = url.startsWith('https');
        const lib = isHttps ? https : http;
        
        const requestOptions = {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'PreLaunchTest/1.0.0'
            },
            timeout: CONFIG.TIMEOUT,
            ...options
        };

        const req = lib.request(url, requestOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(data);
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        data: parsedData
                    });
                } catch (e) {
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        data: data
                    });
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        if (options.body) {
            req.write(JSON.stringify(options.body));
        }

        req.end();
    });
}

// ====================================================================
// TEST SUITE 1: ENVIRONMENT VALIDATION
// ====================================================================

async function testEnvironmentVariables() {
    log('INFO', '🔍 Testing Environment Variables...');

    const requiredVars = [
        { name: 'STRIPE_SECRET_KEY', critical: true, pattern: /^sk_(test_|live_)/ },
        { name: 'STRIPE_PUBLIC_KEY', critical: true, pattern: /^pk_(test_|live_)/ },
        { name: 'STRIPE_PRICE_MONTHLY', critical: true, pattern: /^price_/ },
        { name: 'STRIPE_PRICE_QUARTERLY', critical: false, pattern: /^price_/ },
        { name: 'STRIPE_PRICE_YEARLY', critical: false, pattern: /^price_/ },
        { name: 'MONGODB_URI', critical: true, pattern: /^mongodb/ },
        { name: 'JWT_SECRET', critical: true, minLength: 32 },
        { name: 'STRIPE_WEBHOOK_SECRET', critical: false, pattern: /^whsec_/ },
        { name: 'EMAIL_USER', critical: false },
        { name: 'EMAIL_PASS', critical: false }
    ];

    let envValid = true;

    for (const envVar of requiredVars) {
        const value = process.env[envVar.name];
        
        if (!value) {
            if (envVar.critical) {
                log('CRITICAL', `Missing critical environment variable: ${envVar.name}`);
                envValid = false;
            } else {
                log('WARN', `Missing optional environment variable: ${envVar.name}`);
            }
            continue;
        }

        // Validate pattern
        if (envVar.pattern && !envVar.pattern.test(value)) {
            log('FAIL', `Invalid format for ${envVar.name}`, { pattern: envVar.pattern.toString() });
            if (envVar.critical) envValid = false;
            continue;
        }

        // Validate minimum length
        if (envVar.minLength && value.length < envVar.minLength) {
            log('FAIL', `${envVar.name} too short (minimum ${envVar.minLength} characters)`);
            if (envVar.critical) envValid = false;
            continue;
        }

        // Check if using test vs live keys
        if (envVar.name.includes('STRIPE') && value.includes('test_')) {
            log('WARN', `Using Stripe TEST keys for ${envVar.name} - ensure this is intentional`);
        } else if (envVar.name.includes('STRIPE') && value.includes('live_')) {
            log('INFO', `Using Stripe LIVE keys for ${envVar.name} ✅`);
        }

        log('PASS', `${envVar.name}: ${'*'.repeat(Math.min(value.length, 10))}...`);
    }

    return envValid;
}

// ====================================================================
// TEST SUITE 2: DATABASE CONNECTIVITY
// ====================================================================

async function testDatabaseConnection() {
    log('INFO', '🗄️ Testing Database Connection...');

    try {
        // Test MongoDB connection
        await mongoose.connect(CONFIG.MONGODB_URI, {
            serverSelectionTimeoutMS: CONFIG.TIMEOUT
        });

        log('PASS', 'MongoDB connection successful');

        // Test database operations
        const collections = await mongoose.connection.db.listCollections().toArray();
        const collectionNames = collections.map(c => c.name);
        
        log('INFO', 'Available collections:', collectionNames);

        // Check required collections exist or can be created
        const requiredCollections = ['userauths', 'users', 'subscriptions', 'payments', 'usagelogs'];
        
        for (const collectionName of requiredCollections) {
            if (collectionNames.includes(collectionName)) {
                log('PASS', `Collection exists: ${collectionName}`);
            } else {
                log('WARN', `Collection missing (will be created on first use): ${collectionName}`);
            }
        }

        // Test write operations
        const testDoc = await mongoose.connection.db.collection('test').insertOne({
            test: true,
            timestamp: new Date(),
            source: 'pre-launch-test'
        });

        if (testDoc.insertedId) {
            log('PASS', 'Database write operation successful');
            
            // Clean up test document
            await mongoose.connection.db.collection('test').deleteOne({ _id: testDoc.insertedId });
            log('PASS', 'Database cleanup successful');
        }

        return true;

    } catch (error) {
        log('CRITICAL', 'Database connection failed', error.message);
        return false;
    }
}

// ====================================================================
// TEST SUITE 3: STRIPE INTEGRATION
// ====================================================================

async function testStripeIntegration() {
    log('INFO', '💳 Testing Stripe Integration...');

    try {
        // Test Stripe connection
        const account = await stripe.accounts.retrieve();
        log('PASS', `Stripe account connected: ${account.email || account.id}`);

        // Validate price IDs
        const priceIds = [
            { name: 'Monthly', id: process.env.STRIPE_PRICE_MONTHLY },
            { name: 'Quarterly', id: process.env.STRIPE_PRICE_QUARTERLY },
            { name: 'Yearly', id: process.env.STRIPE_PRICE_YEARLY }
        ].filter(p => p.id);

        for (const priceInfo of priceIds) {
            try {
                const price = await stripe.prices.retrieve(priceInfo.id);
                const amount = (price.unit_amount / 100).toFixed(2);
                log('PASS', `Price validated: ${priceInfo.name} - $${amount} ${price.currency.toUpperCase()}`);
            } catch (error) {
                log('FAIL', `Invalid price ID for ${priceInfo.name}: ${priceInfo.id}`, error.message);
            }
        }

        // Test webhook endpoint configuration (if webhook secret exists)
        if (process.env.STRIPE_WEBHOOK_SECRET) {
            try {
                const webhooks = await stripe.webhookEndpoints.list({ limit: 10 });
                if (webhooks.data.length > 0) {
                    log('PASS', `Webhook endpoints configured: ${webhooks.data.length}`);
                    webhooks.data.forEach(webhook => {
                        log('INFO', `Webhook: ${webhook.url} (${webhook.enabled_events.length} events)`);
                    });
                } else {
                    log('WARN', 'No webhook endpoints found - consider setting up webhooks for production');
                }
            } catch (error) {
                log('WARN', 'Could not retrieve webhook information', error.message);
            }
        } else {
            log('WARN', 'STRIPE_WEBHOOK_SECRET not set - webhooks not configured');
        }

        return true;

    } catch (error) {
        log('CRITICAL', 'Stripe integration failed', error.message);
        return false;
    }
}

// ====================================================================
// TEST SUITE 4: API ENDPOINTS
// ====================================================================

async function testAPIEndpoints() {
    log('INFO', '🔗 Testing API Endpoints...');

    const endpoints = [
        { path: '/api/health', method: 'GET', critical: true },
        { path: '/api/plans', method: 'GET', critical: true },
        { path: '/api/subscription-status/test-user', method: 'GET', critical: true },
        { path: '/api/create-checkout-session', method: 'POST', critical: true, 
          body: { 
              planId: 'monthly', 
              userId: CONFIG.TEST_USER_ID, 
              successUrl: 'https://example.com/success',
              cancelUrl: 'https://example.com/cancel'
          }
        },
        { path: '/api/start-trial', method: 'POST', critical: false,
          body: { userId: CONFIG.TEST_USER_ID }
        }
    ];

    let allPassed = true;

    for (const endpoint of endpoints) {
        try {
            const options = {
                method: endpoint.method,
                headers: {
                    'Content-Type': 'application/json'
                }
            };

            if (endpoint.body) {
                options.body = endpoint.body;
            }

            const response = await makeRequest(`${CONFIG.BASE_URL}${endpoint.path}`, options);

            if (response.statusCode >= 200 && response.statusCode < 300) {
                log('PASS', `${endpoint.method} ${endpoint.path}: ${response.statusCode}`);
                
                // Additional validation for specific endpoints
                if (endpoint.path === '/api/health' && response.data.status === 'healthy') {
                    log('PASS', 'Health check reports healthy status');
                }
                
                if (endpoint.path === '/api/plans' && response.data.plans) {
                    log('PASS', `Plans endpoint returned ${response.data.plans.length} plans`);
                }

            } else {
                const level = endpoint.critical ? 'CRITICAL' : 'FAIL';
                log(level, `${endpoint.method} ${endpoint.path}: ${response.statusCode}`, response.data);
                if (endpoint.critical) allPassed = false;
            }

        } catch (error) {
            const level = endpoint.critical ? 'CRITICAL' : 'FAIL';
            log(level, `${endpoint.method} ${endpoint.path}: Connection failed`, error.message);
            if (endpoint.critical) allPassed = false;
        }
    }

    return allPassed;
}

// ====================================================================
// TEST SUITE 5: PAYMENT FLOW SIMULATION (FIXED)
// ====================================================================

async function testPaymentFlow() {
    log('INFO', '💰 Testing Payment Flow Simulation...');

    try {
        // 1. Create checkout session
        log('INFO', 'Step 1: Creating checkout session...');
        
        const checkoutResponse = await makeRequest(`${CONFIG.BASE_URL}/api/create-checkout-session`, {
            method: 'POST',
            body: {
                planId: 'monthly',
                userId: CONFIG.TEST_USER_ID,
                successUrl: 'https://example.com/success',
                cancelUrl: 'https://example.com/cancel'
            }
        });

        // ✅ FIXED: Handle both response formats
        const sessionId = checkoutResponse.data.sessionId || checkoutResponse.data.session_id;
        const checkoutUrl = checkoutResponse.data.url || checkoutResponse.data.checkout_url;

        if (checkoutResponse.statusCode === 200 && sessionId) {
            log('PASS', 'Checkout session created successfully', {
                sessionId: sessionId,
                url: checkoutUrl ? 'URL provided' : 'No URL'
            });

            // 2. Verify the session exists in Stripe
            try {
                const session = await stripe.checkout.sessions.retrieve(sessionId);
                log('PASS', 'Checkout session verified in Stripe', {
                    status: session.payment_status,
                    amount: session.amount_total / 100
                });
            } catch (error) {
                log('FAIL', 'Could not verify session in Stripe', error.message);
            }

        } else {
            log('FAIL', 'Checkout session creation failed', checkoutResponse.data);
            return false;
        }

        // 3. Test subscription status endpoint
        log('INFO', 'Step 2: Testing subscription status...');
        
        const statusResponse = await makeRequest(`${CONFIG.BASE_URL}/api/subscription-status/${CONFIG.TEST_USER_ID}`);
        
        if (statusResponse.statusCode === 200) {
            log('PASS', 'Subscription status endpoint working', {
                status: statusResponse.data.subscription?.status || 'none',
                plan: statusResponse.data.subscription?.plan || 'none'
            });
        } else {
            log('WARN', 'Subscription status endpoint issues', statusResponse.data);
        }

        return true;

    } catch (error) {
        log('FAIL', 'Payment flow test failed', error.message);
        return false;
    }
}

// ====================================================================
// TEST SUITE 6: SECURITY VALIDATION
// ====================================================================

async function testSecurity() {
    log('INFO', '🔒 Testing Security Configuration...');

    let securityScore = 0;
    const maxScore = 8;

    // Test 1: CORS Configuration
    try {
        const response = await makeRequest(`${CONFIG.BASE_URL}/api/health`, {
            headers: {
                'Origin': 'https://malicious-site.com'
            }
        });
        
        const corsHeader = response.headers['access-control-allow-origin'];
        if (corsHeader === '*') {
            log('WARN', 'CORS allows all origins - consider restricting in production');
        } else if (corsHeader) {
            log('PASS', 'CORS properly configured');
            securityScore++;
        }
    } catch (error) {
        log('INFO', 'Could not test CORS configuration');
    }

    // Test 2: Rate Limiting
    try {
        const promises = Array(20).fill().map(() => 
            makeRequest(`${CONFIG.BASE_URL}/api/health`)
        );
        
        const responses = await Promise.all(promises);
        const rateLimited = responses.some(r => r.statusCode === 429);
        
        if (rateLimited) {
            log('PASS', 'Rate limiting is active');
            securityScore += 2;
        } else {
            log('WARN', 'Rate limiting may not be configured');
        }
    } catch (error) {
        log('INFO', 'Could not test rate limiting');
    }

    // Test 3: JWT Secret Strength
    const jwtSecret = process.env.JWT_SECRET;
    if (jwtSecret && jwtSecret.length >= 64) {
        log('PASS', 'JWT secret has good length');
        securityScore++;
    } else if (jwtSecret && jwtSecret.length >= 32) {
        log('WARN', 'JWT secret length is adequate but could be longer');
        securityScore++;
    } else {
        log('FAIL', 'JWT secret is too short or missing');
    }

    // Test 4: Environment Detection
    if (process.env.NODE_ENV === 'production') {
        log('PASS', 'NODE_ENV set to production');
        securityScore++;
    } else {
        log('WARN', 'NODE_ENV not set to production');
    }

    // Test 5: HTTPS Check (for production)
    if (CONFIG.BASE_URL.startsWith('https://')) {
        log('PASS', 'Using HTTPS');
        securityScore += 2;
    } else {
        log('WARN', 'Not using HTTPS - required for production');
    }

    // Test 6: Database Connection Security
    if (CONFIG.MONGODB_URI.includes('ssl=true') || CONFIG.MONGODB_URI.includes('mongodb+srv://')) {
        log('PASS', 'Database connection appears to use SSL');
        securityScore++;
    } else {
        log('WARN', 'Database connection may not use SSL');
    }

    log('INFO', `Security Score: ${securityScore}/${maxScore}`);
    
    if (securityScore >= 6) {
        log('PASS', 'Security configuration is good');
        return true;
    } else {
        log('WARN', 'Security configuration needs improvement');
        return false;
    }
}

// ====================================================================
// TEST SUITE 7: PERFORMANCE CHECK
// ====================================================================

async function testPerformance() {
    log('INFO', '⚡ Testing Performance...');

    const performanceTests = [
        { name: 'Health Check', path: '/api/health', maxTime: 1000 },
        { name: 'Plans Endpoint', path: '/api/plans', maxTime: 2000 },
        { name: 'Subscription Status', path: `/api/subscription-status/${CONFIG.TEST_USER_ID}`, maxTime: 3000 }
    ];

    let allPassed = true;

    for (const test of performanceTests) {
        const startTime = Date.now();
        
        try {
            const response = await makeRequest(`${CONFIG.BASE_URL}${test.path}`);
            const responseTime = Date.now() - startTime;

            if (responseTime <= test.maxTime) {
                log('PASS', `${test.name}: ${responseTime}ms (target: <${test.maxTime}ms)`);
            } else {
                log('WARN', `${test.name}: ${responseTime}ms (slow - target: <${test.maxTime}ms)`);
                allPassed = false;
            }

        } catch (error) {
            log('FAIL', `${test.name}: Failed to complete`, error.message);
            allPassed = false;
        }
    }

    return allPassed;
}

// ====================================================================
// MAIN TEST RUNNER
// ====================================================================

async function runAllTests() {
    console.log(`${colors.cyan}
╔══════════════════════════════════════════════════════════════════════════════╗
║                     🚀 PRE-LAUNCH TESTING SCRIPT                            ║
║                            AI Interview Assistant                             ║
╚══════════════════════════════════════════════════════════════════════════════╝
${colors.reset}`);

    log('INFO', 'Starting comprehensive pre-launch testing...');
    log('INFO', `Target URL: ${CONFIG.BASE_URL}`);
    log('INFO', `MongoDB URI: ${CONFIG.MONGODB_URI.replace(/\/\/.*@/, '//***:***@')}`);

    const testSuites = [
        { name: 'Environment Variables', fn: testEnvironmentVariables, critical: true },
        { name: 'Database Connection', fn: testDatabaseConnection, critical: true },
        { name: 'Stripe Integration', fn: testStripeIntegration, critical: true },
        { name: 'API Endpoints', fn: testAPIEndpoints, critical: true },
        { name: 'Payment Flow', fn: testPaymentFlow, critical: true },
        { name: 'Security Configuration', fn: testSecurity, critical: false },
        { name: 'Performance Check', fn: testPerformance, critical: false }
    ];

    let criticalFailures = 0;
    const results = [];

    for (const suite of testSuites) {
        console.log(`\n${colors.yellow}${'='.repeat(80)}${colors.reset}`);
        log('INFO', `Running Test Suite: ${suite.name}`);
        console.log(`${colors.yellow}${'='.repeat(80)}${colors.reset}`);

        try {
            const passed = await suite.fn();
            results.push({ name: suite.name, passed, critical: suite.critical });
            
            if (!passed && suite.critical) {
                criticalFailures++;
            }

        } catch (error) {
            log('CRITICAL', `Test suite ${suite.name} crashed`, error.message);
            results.push({ name: suite.name, passed: false, critical: suite.critical });
            
            if (suite.critical) {
                criticalFailures++;
            }
        }
    }

    // Generate final report
    console.log(`\n${colors.cyan}
╔══════════════════════════════════════════════════════════════════════════════╗
║                            📊 FINAL REPORT                                  ║
╚══════════════════════════════════════════════════════════════════════════════╝
${colors.reset}`);

    console.log(`\n${colors.white}Test Results Summary:${colors.reset}`);
    console.log(`${colors.green}✅ Passed: ${testResults.passed}${colors.reset}`);
    console.log(`${colors.red}❌ Failed: ${testResults.failed}${colors.reset}`);
    console.log(`${colors.yellow}⚠️  Warnings: ${testResults.warnings}${colors.reset}`);
    console.log(`${colors.magenta}🚨 Critical: ${testResults.critical}${colors.reset}`);

    console.log(`\n${colors.white}Test Suite Results:${colors.reset}`);
    results.forEach(result => {
        const icon = result.passed ? '✅' : '❌';
        const criticality = result.critical ? '(CRITICAL)' : '(optional)';
        console.log(`${icon} ${result.name} ${criticality}`);
    });

    // Final recommendation
    console.log(`\n${colors.white}Launch Readiness Assessment:${colors.reset}`);
    
    if (criticalFailures === 0) {
        console.log(`${colors.green}
🎉 READY TO LAUNCH! 🎉
All critical systems are working properly.${colors.reset}`);
        
        if (testResults.warnings > 0) {
            console.log(`${colors.yellow}
⚠️  Note: ${testResults.warnings} warnings detected. Consider addressing these for optimal performance.${colors.reset}`);
        }
        
        console.log(`${colors.cyan}
📋 Pre-Launch Checklist:
✅ Database is connected and operational
✅ Stripe integration is working
✅ API endpoints are responding
✅ Payment flow is functional
✅ Environment variables are configured

🚀 You're ready to go live!${colors.reset}`);
        
    } else {
        console.log(`${colors.red}
🚫 NOT READY FOR LAUNCH
${criticalFailures} critical issue(s) must be resolved before going live.${colors.reset}`);
        
        console.log(`${colors.yellow}
🔧 Action Required:
1. Review the failed tests above
2. Fix all critical issues
3. Re-run this script
4. Ensure all critical tests pass before launching${colors.reset}`);
    }

    // Cleanup
    if (mongoose.connection.readyState === 1) {
        await mongoose.connection.close();
        log('INFO', 'Database connection closed');
    }

    process.exit(criticalFailures > 0 ? 1 : 0);
}

// ====================================================================
// ERROR HANDLING AND STARTUP
// ====================================================================

process.on('unhandledRejection', (reason, promise) => {
    log('CRITICAL', 'Unhandled Promise Rejection', reason);
    process.exit(1);
});

process.on('uncaughtException', (error) => {
    log('CRITICAL', 'Uncaught Exception', error.message);
    process.exit(1);
});

// Start the test suite
runAllTests().catch(error => {
    log('CRITICAL', 'Test runner failed', error.message);
    process.exit(1);
});