# Use Node 16 as it's more stable with bluetooth-hci-socket
FROM node:16-bullseye-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    python3 \
    libbluetooth-dev \
    libudev-dev \
    bluetooth \
    bluez \
    libusb-1.0-0-dev \
 && rm -rf /var/lib/apt/lists/*

# Clone your GitHub repo
RUN git clone https://github.com/swissmilo/aranet_smarthome.git /usr/src/app

# Set the working directory
WORKDIR /usr/src/app


# Install dependencies
RUN npm install --build-from-source

# Set necessary capabilities for Node.js
RUN setcap cap_net_raw,cap_net_admin+eip `readlink -f \`which node\``

# (Optional) If you expose any ports in your code, you can EXPOSE them here
# EXPOSE 3000

# Default command
CMD ["node", "index.js"]
