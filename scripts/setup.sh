#!/bin/bash

echo "========================================="
echo "Enhanced Solana Trading Bot Setup v2.0"
echo "========================================="
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check Node.js version
echo "Checking Node.js version..."
NODE_VERSION=$(node -v 2>/dev/null)
if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Node.js is not installed!${NC}"
    echo "Please install Node.js 16+ from https://nodejs.org/"
    exit 1
fi

NODE_MAJOR=$(echo $NODE_VERSION | cut -d'.' -f1 | sed 's/v//')
if [ "$NODE_MAJOR" -lt 16 ]; then
    echo -e "${RED}❌ Node.js version $NODE_VERSION is too old!${NC}"
    echo "Please upgrade to Node.js 16 or higher"
    exit 1
fi

echo -e "${GREEN}✅ Node.js $NODE_VERSION${NC}"

# Create directory structure
echo ""
echo "Creating directory structure..."
mkdir -p modules
mkdir -p logs
mkdir -p data
mkdir -p scripts
echo -e "${GREEN}✅ Directories created${NC}"

# Check if .env exists
echo ""
if [ -f .env ]; then
    echo -e "${YELLOW}⚠️  .env file already exists${NC}"
    read -p "Do you want to overwrite it? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Keeping existing .env file"
    else
        cp .env.example .env
        echo -e "${GREEN}✅ .env file created from template${NC}"
    fi
else
    cp .env.example .env
    echo -e "${GREEN}✅ .env file created from template${NC}"
fi

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Failed to install dependencies${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Dependencies installed${NC}"

# Create initial files if they don't exist
echo ""
echo "Setting up initial configuration..."

# Create module files directory if needed
if [ ! -f "modules/database.js" ]; then
    echo -e "${YELLOW}⚠️  Module files not found${NC}"
    echo "Please ensure all module files are in the modules/ directory:"
    echo "  - modules/database.js"
    echo "  - modules/indicators.js"
    echo "  - modules/dex-aggregator.js"
    echo "  - modules/mev-protection.js"
    echo "  - modules/backtest.js"
    echo "  - modules/health-monitor.js"
    echo "  - modules/anomaly-detector.js"
fi

# Configuration wizard
echo ""
echo "========================================="
echo "Configuration Wizard"
echo "========================================="
echo ""

read -p "Do you want to configure the bot now? (Y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Nn]$ ]]; then
    echo "Skipping configuration. Edit .env file manually."
else
    echo ""
    echo "Please provide the following information:"
    echo ""
    
    read -p "Telegram Bot Token: " TELEGRAM_TOKEN
    read -p "Bitquery API Key: " BITQUERY_API_KEY
    read -p "Helius API Key: " HELIUS_API_KEY
    read -p "Wallet Private Key (Base58): " PRIVATE_KEY
    read -p "Authorized Telegram User ID: " AUTHORIZED_USER
    
    # Update .env file
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        sed -i '' "s/TELEGRAM_TOKEN=.*/TELEGRAM_TOKEN=$TELEGRAM_TOKEN/" .env
        sed -i '' "s/BITQUERY_API_KEY=.*/BITQUERY_API_KEY=$BITQUERY_API_KEY/" .env
        sed -i '' "s/HELIUS_API_KEY=.*/HELIUS_API_KEY=$HELIUS_API_KEY/" .env
        sed -i '' "s/PRIVATE_KEY=.*/PRIVATE_KEY=$PRIVATE_KEY/" .env
        sed -i '' "s/AUTHORIZED_USERS=.*/AUTHORIZED_USERS=$AUTHORIZED_USER/" .env
    else
        # Linux
        sed -i "s/TELEGRAM_TOKEN=.*/TELEGRAM_TOKEN=$TELEGRAM_TOKEN/" .env
        sed -i "s/BITQUERY_API_KEY=.*/BITQUERY_API_KEY=$BITQUERY_API_KEY/" .env
        sed -i "s/HELIUS_API_KEY=.*/HELIUS_API_KEY=$HELIUS_API_KEY/" .env
        sed -i "s/PRIVATE_KEY=.*/PRIVATE_KEY=$PRIVATE_KEY/" .env
        sed -i "s/AUTHORIZED_USERS=.*/AUTHORIZED_USERS=$AUTHORIZED_USER/" .env
    fi
    
    echo -e "${GREEN}✅ Configuration saved${NC}"
fi

# Create test script
echo ""
echo "Creating test script..."
cat > test-connection.js << 'EOF'
require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');

async function test