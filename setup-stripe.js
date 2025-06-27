#!/usr/bin/env node

// ====================================================================
// Stripe Setup Validation Script
// Run this to validate your Stripe configuration
// ====================================================================

require('dotenv').config();

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

async function validateStripeSetup() {
    console.log('🔍 Validating Stripe Configuration...\n');

    // Check environment variables
    const requiredVars = [
        'STRIPE_SECRET_KEY',
        'STRIPE_PUBLIC_KEY',
        'STRIPE_PRICE_MONTHLY',
        'STRIPE_PRICE_QUARTERLY',
        'STRIPE_PRICE_YEARLY'
    ];

    console.log('📋 Checking Environment Variables:');
    let envValid = true;
    
    requiredVars.forEach(varName => {
        const value = process.env[varName];
        if (value) {
            console.log(`   ✅ ${varName}: ${varName.includes('SECRET') ? '***' : value}`);
        } else {
            console.log(`   ❌ ${varName}: Missing`);
            envValid = false;
        }
    });

    if (!envValid) {
        console.log('\n❌ Environment variables missing. Please check your .env file.');
        process.exit(1);
    }

    // Test Stripe connection
    console.log('\n🔗 Testing Stripe Connection:');
    try {
        const account = await stripe.accounts.retrieve();
        console.log(`   ✅ Connected to Stripe account: ${account.email || account.id}`);
    } catch (error) {
        console.log(`   ❌ Stripe connection failed: ${error.message}`);
        process.exit(1);
    }

    // Validate Price IDs
    console.log('\n💰 Validating Price IDs:');
    const priceIds = [
        { name: 'Monthly', id: process.env.STRIPE_PRICE_MONTHLY },
        { name: 'Quarterly', id: process.env.STRIPE_PRICE_QUARTERLY },
        { name: 'Yearly', id: process.env.STRIPE_PRICE_YEARLY }
    ];

    for (const priceInfo of priceIds) {
        try {
            const price = await stripe.prices.retrieve(priceInfo.id);
            const amount = (price.unit_amount / 100).toFixed(2);
            console.log(`   ✅ ${priceInfo.name}: $${amount} ${price.currency.toUpperCase()} (${price.recurring.interval})`);
        } catch (error) {
            console.log(`   ❌ ${priceInfo.name}: Invalid price ID - ${error.message}`);
            envValid = false;
        }
    }

    if (!envValid) {
        console.log('\n❌ Some price IDs are invalid. Please check your Stripe Dashboard.');
        console.log('🔗 Create prices at: https://dashboard.stripe.com/test/products');
        process.exit(1);
    }

    console.log('\n🎉 ===============================================');
    console.log('✅ Stripe Configuration Valid!');
    console.log('===============================================');
    console.log('Your backend is ready to process payments.');
    console.log('You can now start the server with: npm start');
    console.log('===============================================\n');
}

// Handle script execution
if (require.main === module) {
    validateStripeSetup().catch(error => {
        console.error('\n❌ Validation failed:', error.message);
        process.exit(1);
    });
}

module.exports = validateStripeSetup;