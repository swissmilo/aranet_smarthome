const noble = require('@abandonware/noble');
const readline = require('readline');
const axios = require('axios');
require('dotenv').config();

// Check if we're running on Linux (Raspberry Pi)
if (process.platform === 'linux') {
    // noble needs special permissions on Linux
    console.log('Running on Linux, checking Bluetooth permissions...');
    try {
        const { execSync } = require('child_process');
        // Check if we have the necessary permissions
        execSync('hciconfig hci0 up');
    } catch (error) {
        console.error('Error accessing Bluetooth device. Make sure you have the right permissions:');
        console.error('Try running: sudo setcap cap_net_raw+eip $(eval readlink -f `which node`)');
        process.exit(1);
    }
}

// Configuration from environment variables
const CONFIG = {
    API_ENDPOINT: process.env.API_ENDPOINT,
    API_KEY: process.env.API_KEY,
    DEVICE_ID: process.env.DEVICE_ID
};

let aranet4Device = null;

// Create readline interface for PIN input
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Function to get PIN from user
function getPIN() {
    return new Promise((resolve) => {
        rl.question('Enter the PIN shown on Aranet4 display: ', (pin) => {
            resolve(pin.trim());
        });
    });
}

function parseCurrentReadings(data) {
    // Check if we have a valid buffer with enough bytes
    if (!Buffer.isBuffer(data)) {
        throw new Error('Invalid data: not a buffer');
    }
    
    // We expect at least 7 bytes for all our readings
    // (2 bytes CO2, 2 bytes temp, 2 bytes pressure, 1 byte humidity)
    if (data.length < 7) {
        throw new Error(`Invalid data length: got ${data.length} bytes, expected at least 7 bytes`);
    }

    try {
        return {
            co2: data.readUInt16LE(0),
            temperature: data.readInt16LE(2) / 20,
            humidity: data.readUInt8(6),
            pressure: data.readUInt16LE(4) / 10,
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        console.error('Raw buffer data:', data);
        console.error('Buffer length:', data.length);
        throw new Error(`Failed to parse sensor data: ${error.message}`);
    }
}

// Function to post data to server
async function postToServer(readings) {
    try {
        const payload = {
            deviceId: CONFIG.DEVICE_ID,
            readings: {
                co2: readings.co2,
                temperature: readings.temperature,
                humidity: readings.humidity,
                pressure: readings.pressure,
                timestamp: readings.timestamp
            }
        };

        const response = await axios.post(CONFIG.API_ENDPOINT, payload, {
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': CONFIG.API_KEY
            }
        });

        if (response.status === 200) {
            console.log('Successfully posted to server');
        } else {
            console.error('Server responded with status:', response.status);
        }
    } catch (error) {
        console.error('Error posting to server:', error.message);
    }
}

async function connectAndRead(peripheral) {
    try {
        console.log('\nAttempting to connect...');
        
        // Set up pairing handler before connecting
        peripheral.once('connect', () => {
            console.log('Connected, waiting for pairing...');
        });

        await peripheral.connectAsync();
        
        // Wait a bit for potential pairing request
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log('Discovering services...');
        const services = await peripheral.discoverServicesAsync();
        console.log(`Found ${services.length} services`);
        
        const aranetService = services.find(s => s.uuid === 'fce0');
        if (!aranetService) {
            throw new Error('Aranet service not found');
        }
        
        console.log('Discovering characteristics...');
        const characteristics = await aranetService.discoverCharacteristicsAsync();
        console.log(`Found ${characteristics.length} characteristics`);
        
        const currentReadingsChar = characteristics.find(
            c => c.uuid === 'f0cd150395da4f4b9ac8aa55d312af0c'
        );
        
        if (!currentReadingsChar) {
            throw new Error('Current readings characteristic not found');
        }

        // Single read operation
        const data = await new Promise((resolve, reject) => {
            currentReadingsChar.read((error, data) => {
                if (error) reject(error);
                else if (!data || data.length === 0) {
                    reject(new Error('Received empty data from sensor'));
                } else {
                    resolve(data);
                }
            });
        });
        
        const readings = parseCurrentReadings(data);
        const localTime = new Date(readings.timestamp).toLocaleTimeString();
        console.log(`\n[${localTime}] Readings:`);
        console.log(`CO2: ${readings.co2} ppm`);
        console.log(`Temperature: ${readings.temperature.toFixed(1)}°C`);
        console.log(`Humidity: ${readings.humidity}%`);
        console.log(`Pressure: ${readings.pressure.toFixed(1)} hPa`);

        // Post to server
        await postToServer(readings);
        
        // Clean disconnect
        await peripheral.disconnectAsync();
        console.log('Successfully disconnected from device');
        
        return 'success';
    } catch (error) {
        console.error('Error in connectAndRead:', error);
        try {
            if (peripheral.state === 'connected') {
                await peripheral.disconnectAsync();
                console.log('Cleaned up connection after error');
            }
        } catch (disconnectError) {
            console.error('Error during disconnect:', disconnectError);
        }
        throw error;
    }
}

async function startScanning() {
    return new Promise((resolve, reject) => {
        let isConnected = false;

        // Handle security/pairing requests
        noble.on('security', async (peripheral, type) => {
            console.log(`Security request type: ${type}`);
            if (type === 'legacy') {
                const pin = await getPIN();
                peripheral.sendPairingResponse(pin);
            }
        });

        const handleStateChange = async (state) => {
            console.log('Bluetooth adapter state:', state);
            if (state === 'poweredOn' && !isConnected) {
                console.log('Scanning for BLE devices...');
                try {
                    await noble.startScanningAsync([], false);
                } catch (error) {
                    console.error('Error starting scan:', error);
                    // On Raspberry Pi, we might need to reset the Bluetooth adapter
                    if (process.platform === 'linux') {
                        console.log('Attempting to reset Bluetooth adapter...');
                        try {
                            const { execSync } = require('child_process');
                            execSync('sudo hciconfig hci0 reset');
                            // Wait a bit for the adapter to reset
                            await new Promise(resolve => setTimeout(resolve, 2000));
                            await noble.startScanningAsync([], false);
                        } catch (resetError) {
                            console.error('Error resetting Bluetooth adapter:', resetError);
                        }
                    }
                }
            }
        };

        const handleDiscover = async (peripheral) => {
            const name = peripheral.advertisement.localName;
            
            if (name?.includes('Aranet4') && !isConnected) {
                console.log('Found Aranet4 device! Details:');
                console.log('Name:', name);
                
                aranet4Device = peripheral;
                isConnected = true;
                
                // Remove event listeners
                noble.removeListener('stateChange', handleStateChange);
                noble.removeListener('discover', handleDiscover);
                
                await noble.stopScanningAsync();
                resolve(peripheral);
            }
        };

        // Set up event handlers
        noble.on('stateChange', handleStateChange);
        noble.on('discover', handleDiscover);

        // Initial state check
        if (noble.state === 'poweredOn') {
            handleStateChange('poweredOn');
        }
    });
}

// Main application flow
async function main() {
    const POLLING_INTERVAL = 1800000; // 30 minutes
    
    while (true) {
        try {
            console.log('Starting device discovery...');
            const peripheral = await startScanning();
            const result = await connectAndRead(peripheral);
            
            if (result === 'success') {
                console.log(`\nWaiting ${POLLING_INTERVAL/60000} minutes until next reading...`);
                await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL));
            } else {
                // If not successful, wait a shorter time before retry
                console.log('Waiting 30 seconds before retry...');
                await new Promise(resolve => setTimeout(resolve, 30000));
            }
        } catch (error) {
            console.error('Connection error:', error.message);
            console.log('Waiting 30 seconds before retry...');
            await new Promise(resolve => setTimeout(resolve, 30000));
        }
    }
}

// Handle cleanup on exit
async function cleanup() {
    console.log('\nCleaning up...');
    if (aranet4Device && aranet4Device.state === 'connected') {
        try {
            await noble.stopScanningAsync();
            await aranet4Device.disconnectAsync();
        } catch (error) {
            console.error('Error during disconnect:', error);
        }
    }
    rl.close();
    process.exit(0);
}

// Handle different exit scenarios
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', () => {
    rl.close();
});

// Start the application
main().catch(error => {
    console.error('Error in main application:', error);
    cleanup();
}); 