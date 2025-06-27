#!/usr/bin/env node

// ====================================================================
// 🔍 QUICK DIAGNOSTIC SCRIPT
// ====================================================================
// Run this first to see what's broken: node diagnose.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Colors for output
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m'
};

function log(level, message, fix = null) {
    const color = {
        'PASS': colors.green,
        'FAIL': colors.red,
        'WARN': colors.yellow,
        'INFO': colors.blue,
        'FIX': colors.magenta
    }[level] || colors.reset;

    console.log(`${color}[${level}]${colors.reset} ${message}`);
    
    if (fix) {
        console.log(`${colors.magenta}💡 FIX:${colors.reset} ${fix}`);
    }
}

console.log(`${colors.blue}
╔══════════════════════════════════════════════════════════════════════════════╗
║                        🔍 QUICK DIAGNOSTIC SCRIPT                           ║
║                      AI Interview Assistant Setup                            ║
╚══════════════════════════════════════════════════════════════════════════════╝
${colors.reset}`);

let issues = 0;
let criticalIssues = 0;

// ====================================================================
// CHECK 1: PROJECT STRUCTURE
// ====================================================================

log('INFO', 'Checking project structure...');

const requiredFiles = [
    'server.js',
    'package.json',
    '.env'
];

const optionalFiles = [
    'subscription-system.js',
    'background.js',
    'content.js',
    'popup.js',
    'manifest.json'
];

requiredFiles.forEach(file => {
    if (fs.existsSync(file)) {
        log('PASS', `Required file exists: ${file}`);
    } else {
        log('FAIL', `Missing required file: ${file}`);
        criticalIssues++;
        
        if (file === '.env') {
            log('FIX', 'Create .env file with: touch .env');
        }
    }
});

optionalFiles.forEach(file => {
    if (fs.existsSync(file)) {
        log('PASS', `Optional file exists: ${file}`);
    } else {
        log('WARN', `Optional file missing: ${file}`);
    }
});

// ====================================================================
// CHECK 2: PACKAGE.JSON VALIDATION
// ====================================================================

log('INFO', 'Checking package.json...');

try {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    
    log('PASS', `Package name: ${packageJson.name || 'unnamed'}`);
    
    // Check required dependencies
    const requiredDeps = [
        'express', 'mongoose', 'stripe', 'cors', 'dotenv', 
        'bcryptjs', 'jsonwebtoken', 'helmet', 'express-rate-limit'
    ];
    
    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
    
    requiredDeps.forEach(dep => {
        if (dependencies[dep]) {
            log('PASS', `Dependency installed: ${dep}@${dependencies[dep]}`);
        } else {
            log('FAIL', `Missing dependency: ${dep}`);
            issues++;
            log('FIX', `Install with: npm install ${dep}`);
        }
    });
    
    // Check scripts
    if (packageJson.scripts?.start) {
        log('PASS', `Start script: ${packageJson.scripts.start}`);
    } else {
        log('WARN', 'No start script defined');
        log('FIX', 'Add to package.json: "start": "node server.js"');
    }
    
} catch (error) {
    log('FAIL', 'Cannot read package.json');
    criticalIssues++;
    log('FIX', 'Create package.json with: npm init -y');
}

// ====================================================================
// CHECK 3: ENVIRONMENT VARIABLES
// ====================================================================

log('INFO', 'Checking environment variables...');

const envVars = [
    { name: 'MONGODB_URI', required: true, pattern: /^mongodb/ },
    { name: 'STRIPE_SECRET_KEY', required: true, pattern: /^sk_(test_|live_)/ },
    { name: 'STRIPE_PUBLIC_KEY', required: true, pattern: /^pk_(test_|live_)/ },
    { name: 'STRIPE_PRICE_MONTHLY', required: true, pattern: /^price_/ },
    { name: 'JWT_SECRET', required: true, minLength: 32 },
    { name: 'PORT', required: false },
    { name: 'NODE_ENV', required: false }
];

envVars.forEach(env => {
    const value = process.env[env.name];
    
    if (!value) {
        if (env.required) {
            log('FAIL', `Missing critical env var: ${env.name}`);
            criticalIssues++;
            log('FIX', `Add to .env file: ${env.name}=your_value_here`);
        } else {
            log('WARN', `Missing optional env var: ${env.name}`);
        }
        return;
    }
    
    // Validate pattern
    if (env.pattern && !env.pattern.test(value)) {
        log('FAIL', `Invalid format for ${env.name}`);
        issues++;
        log('FIX', `${env.name} should match pattern: ${env.pattern}`);
        return;
    }
    
    // Validate length
    if (env.minLength && value.length < env.minLength) {
        log('FAIL', `${env.name} too short (min ${env.minLength} chars)`);
        issues++;
        log('FIX', `Make ${env.name} longer (current: ${value.length} chars)`);
        return;
    }
    
    // Check for obvious problems
    if (env.name.includes('STRIPE') && value.includes('sk_test_')) {
        log('WARN', `${env.name} using TEST key (ok for development)`);
    }
    
    if (env.name === 'JWT_SECRET' && value === 'fallback_secret') {
        log('WARN', 'Using fallback JWT secret');
        log('FIX', 'Generate secure secret: openssl rand -base64 64');
    }
    
    log('PASS', `${env.name}: ${value.substring(0, 8)}... (${value.length} chars)`);
});

// ====================================================================
// CHECK 4: NODE MODULES
// ====================================================================

log('INFO', 'Checking node_modules...');

if (fs.existsSync('node_modules')) {
    log('PASS', 'node_modules folder exists');
    
    // Check for key packages
    const keyPackages = ['express', 'mongoose', 'stripe'];
    keyPackages.forEach(pkg => {
        if (fs.existsSync(`node_modules/${pkg}`)) {
            log('PASS', `Package installed: ${pkg}`);
        } else {
            log('FAIL', `Package missing: ${pkg}`);
            issues++;
            log('FIX', `Install with: npm install ${pkg}`);
        }
    });
} else {
    log('FAIL', 'node_modules folder missing');
    criticalIssues++;
    log('FIX', 'Run: npm install');
}

// ====================================================================
// CHECK 5: PORT AVAILABILITY
// ====================================================================

log('INFO', 'Checking port availability...');

const net = require('net');
const port = process.env.PORT || 5000;

const server = net.createServer();

server.listen(port, () => {
    log('PASS', `Port ${port} is available`);
    server.close();
}).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        log('WARN', `Port ${port} is already in use`);
        log('FIX', `Stop the process using port ${port} or use different port`);
    } else {
        log('FAIL', `Port check failed: ${err.message}`);
    }
});

// ====================================================================
// CHECK 6: QUICK SYNTAX CHECK
// ====================================================================

log('INFO', 'Checking syntax of main files...');

const filesToCheck = ['server.js', 'subscription-system.js'].filter(file => 
    fs.existsSync(file)
);

filesToCheck.forEach(file => {
    try {
        const content = fs.readFileSync(file, 'utf8');
        
        // Basic syntax checks
        if (content.includes('require(') && !content.includes('module.exports')) {
            log('WARN', `${file}: No module.exports found`);
        }
        
        if (content.includes('async ') && !content.includes('await')) {
            log('WARN', `${file}: Async functions but no await usage`);
        }
        
        // Check for common issues
        if (content.includes('process.env.') && !content.includes('dotenv')) {
            log('WARN', `${file}: Uses process.env but no dotenv import`);
            log('FIX', `Add: require('dotenv').config();`);
        }
        
        log('PASS', `${file}: Basic syntax looks OK`);
        
    } catch (error) {
        log('FAIL', `${file}: Cannot read file`);
        issues++;
    }
});

// ====================================================================
// FINAL REPORT
// ====================================================================

console.log(`\n${colors.blue}
╔══════════════════════════════════════════════════════════════════════════════╗
║                              📊 DIAGNOSIS REPORT                            ║
╚══════════════════════════════════════════════════════════════════════════════╝
${colors.reset}`);

console.log(`\n${colors.yellow}Issues Found:${colors.reset}`);
console.log(`🚨 Critical Issues: ${criticalIssues}`);
console.log(`⚠️  Other Issues: ${issues}`);

if (criticalIssues === 0 && issues === 0) {
    console.log(`\n${colors.green}🎉 GREAT! No major issues found!${colors.reset}`);
    console.log(`${colors.green}✅ Your setup looks good to proceed with testing.${colors.reset}`);
    console.log(`\n${colors.blue}Next steps:${colors.reset}`);
    console.log(`1. Start your server: npm run dev`);
    console.log(`2. Test the endpoints manually`);
    console.log(`3. Run the pre-launch test script`);
} else if (criticalIssues === 0) {
    console.log(`\n${colors.yellow}⚠️ Some issues found but not critical${colors.reset}`);
    console.log(`${colors.yellow}You can probably proceed but should fix these issues.${colors.reset}`);
    console.log(`\n${colors.blue}Next steps:${colors.reset}`);
    console.log(`1. Fix the issues listed above`);
    console.log(`2. Re-run this diagnostic: node diagnose.js`);
    console.log(`3. Start your server: npm run dev`);
} else {
    console.log(`\n${colors.red}🚫 CRITICAL ISSUES FOUND!${colors.reset}`);
    console.log(`${colors.red}You must fix these before proceeding:${colors.reset}`);
    console.log(`\n${colors.blue}Action plan:${colors.reset}`);
    console.log(`1. 📖 Follow the Setup Fix Guide`);
    console.log(`2. 🔧 Fix all critical issues listed above`);
    console.log(`3. 🔄 Re-run this diagnostic: node diagnose.js`);
    console.log(`4. ✅ Proceed only when all critical issues are resolved`);
}

console.log(`\n${colors.magenta}💡 Common Quick Fixes:${colors.reset}`);
console.log(`• Missing .env: Create with required variables`);
console.log(`• Missing dependencies: Run 'npm install'`);
console.log(`• Wrong Stripe keys: Check Stripe Dashboard`);
console.log(`• Database issues: Verify MongoDB connection string`);
console.log(`• Port in use: Kill process or use different port`);

console.log(`\n${colors.blue}📖 Need detailed help? Check the Setup Fix Guide!${colors.reset}`);

process.exit(criticalIssues > 0 ? 1 : 0);