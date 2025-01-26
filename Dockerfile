# Use Node 18 as it's more stable with bluetooth-hci-socket
FROM node:18-bullseye

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    python3 \
    bluetooth \
    bluez \
    libbluetooth-dev \
    libudev-dev \
    libcap2-bin \
    bluez-tools \
    bluez-firmware \
    && rm -rf /var/lib/apt/lists/*

# Clone the repository
RUN git clone https://github.com/swissmilo/aranet_smarthome.git /usr/src/app

# Set working directory
WORKDIR /usr/src/app

# Copy environment variables from the build context
COPY .env ./

COPY package*.json ./

# Install all Node.js dependencies at once
RUN npm install --build-from-source

# Set capabilities for Node.js binary
RUN setcap cap_net_raw,cap_net_admin+eip `readlink -f \`which node\``

# (Optional) If you expose any ports in your code, you can EXPOSE them here
# EXPOSE 3000

# Start the application
CMD ["npm", "start"]
