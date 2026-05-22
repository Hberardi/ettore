#!/bin/bash
# ETTORE Installation Script

echo "Installing ETTORE..."

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "Error: Node.js 18+ required. Current: $(node -v)"
    exit 1
fi

# Install package globally
npm install -g .

echo ""
echo "✅ ETTORE installed successfully!"
echo ""
echo "Usage:"
echo "  ettore                    # Start interactive mode"
echo "  ettore /help              # Show help"
echo "  ettore /keys add openai <your-api-key>  # Add API key"
echo ""
echo "Get started:"
echo "  ettore --interactive"
echo ""
