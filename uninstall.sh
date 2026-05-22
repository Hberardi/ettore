#!/bin/bash
# ETTORE Uninstall Script

echo "Uninstalling ETTORE..."

npm uninstall -g ettore

echo "✅ ETTORE uninstalled!"
echo "Note: Your config and API keys may still remain in ~/.config/ettore-cli/"
