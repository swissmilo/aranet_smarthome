#!/bin/bash

# Install system dependencies
sudo apt-get update
sudo apt-get install -y bluetooth bluez libbluetooth-dev libudev-dev

# Install Node.js if not already installed
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# Set up the application directory
sudo mkdir -p /opt/aranet-reader
sudo chown pi:pi /opt/aranet-reader

# Install application dependencies
npm install

# Set up Node.js Bluetooth permissions
sudo setcap cap_net_raw+eip $(eval readlink -f `which node`)

# Copy systemd service file
sudo cp aranet-reader.service /etc/systemd/system/

# Reload systemd and enable service
sudo systemctl daemon-reload
sudo systemctl enable aranet-reader
sudo systemctl start aranet-reader

echo "Deployment complete. Check status with: sudo systemctl status aranet-reader" 