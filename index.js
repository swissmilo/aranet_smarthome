const noble = require('@abandonware/noble');
const readline = require('readline');
const axios = require('axios');
require('dotenv').config();

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
    return {
        co2: data.readUInt16LE(0),
        temperature: data.readInt16LE(2) / 20,  // only in Celsius now
        humidity: data.readUInt8(6),
        pressure: data.readUInt16LE(4) / 10,
        timestamp: new Date().toISOString()  // add timestamp at reading time
    };
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

        // Function to read and display current values
        async function readAndDisplayValues() {
            try {
                const data = await new Promise((resolve, reject) => {
                    currentReadingsChar.read((error, data) => {
                        if (error) reject(error);
                        else resolve(data);
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
            } catch (error) {
                console.error('Error reading values:', error);
            }
        }

        // Get initial reading
        await readAndDisplayValues();
        
        console.log('\nPolling every 10 minutes (Press Ctrl+C to exit)...');
        
        // Set up polling interval (10 minutes = 600000 ms)
        const pollInterval = setInterval(readAndDisplayValues, 600000);
        
        // Keep the connection alive and handle cleanup
        await new Promise((resolve) => {
            process.once('SIGINT', () => {
                clearInterval(pollInterval);
                resolve();
            });
        });
        
    } catch (error) {
        console.error('Error in connectAndRead:', error);
        throw error;
    }
}

// Main function to handle device discovery and reading
async function startScanning() {
    // Handle security/pairing requests
    noble.on('security', async (peripheral, type) => {
        console.log(`Security request type: ${type}`);
        if (type === 'legacy') {
            const pin = await getPIN();
            peripheral.sendPairingResponse(pin);
        }
    });

    noble.on('stateChange', async (state) => {
        if (state === 'poweredOn') {
            console.log('Scanning for BLE devices...');
            await noble.startScanningAsync([], false);
        }
    });

    noble.on('discover', async (peripheral) => {
        const name = peripheral.advertisement.localName;
        
        if (name?.includes('Aranet4')) {
            console.log('Found Aranet4 device! Details:');
            console.log('Name:', name);
            
            aranet4Device = peripheral;
            await noble.stopScanningAsync();
            
            try {
                await connectAndRead(peripheral);
            } catch (error) {
                console.error('Error during device operation:', error);
                await cleanup();
            }
        }
    });
}

// Handle cleanup on exit
async function cleanup() {
    console.log('\nCleaning up...');
    if (aranet4Device) {
        try {
            await noble.stopScanningAsync();
            if (aranet4Device.state === 'connected') {
                await aranet4Device.disconnectAsync();
            }
        } catch (error) {
            console.error('Error during disconnect:', error);
        }
    }
    rl.close();
    // Force exit after 1 second if graceful shutdown fails
    setTimeout(() => process.exit(0), 1000);
}

// Handle different exit scenarios
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', () => {
    rl.close();
});

// Start the application
startScanning().catch(error => {
    console.error('Error in main application:', error);
    cleanup();
}); 