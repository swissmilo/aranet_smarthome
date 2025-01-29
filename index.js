const noble = require('@abandonware/noble');
const readline = require('readline');
const axios = require('axios');
const sgMail = require('@sendgrid/mail');
const { Worker } = require('worker_threads');
const path = require('path');
require('dotenv').config();

// Check if we're running on Linux (Raspberry Pi)
/*if (process.platform === 'linux') {
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
}*/

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

// Initialize SendGrid with your API key
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

async function sendErrorEmail(error) {
    const errorTime = new Date().toISOString();
    
    try {
        const msg = {
            to: process.env.EMAIL_TO,
            from: process.env.EMAIL_FROM,  // This needs to be verified in SendGrid
            subject: `Aranet Reader Error - ${CONFIG.DEVICE_ID}`,
            text: `
Error Report from Aranet Reader

Time: ${errorTime}
Device: ${CONFIG.DEVICE_ID}
Location: ${CONFIG.DEVICE_ID.replace('aranet4-', '')}

Error Details:
${error.message}

Stack Trace:
${error.stack}

System Info:
- Node Version: ${process.version}
- Platform: ${process.platform}
- Memory Usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB
- Uptime: ${Math.round(process.uptime() / 3600)}h

Please check the device and restart if necessary.
`
        };

        await sgMail.send(msg);
        console.log('Error notification email sent successfully');
    } catch (emailError) {
        console.error('Failed to send error notification email:', emailError.message);
        if (emailError.response) {
            console.error(emailError.response.body);
        }
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
            
            if (name?.includes('Aranet4 29C35') && !isConnected) {
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

// Update the test email function to use SendGrid
async function testEmailConfig() {
    try {
        const msg = {
            to: process.env.EMAIL_TO,
            from: process.env.EMAIL_FROM,
            subject: 'Aranet Reader - Email Test',
            text: 'This is a test email from your Aranet Reader application.'
        };

        await sgMail.send(msg);
        console.log('Test email sent successfully');
    } catch (error) {
        console.error('Failed to send test email:', error);
        if (error.response) {
            console.error(error.response.body);
        }
    }
}

async function runWorker() {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'worker.js'));
        let isTerminated = false;

        const timeoutId = setTimeout(() => {
            if (!isTerminated) {
                isTerminated = true;
                worker.terminate();
                reject(new Error('Reading operation timed out'));
            }
        }, 60000);

        worker.on('message', async (message) => {
            clearTimeout(timeoutId);
            if (!isTerminated) {
                isTerminated = true;
                if (message.success) {
                    // Log the formatted readings
                    console.log(`\n[${message.formattedReadings.time}] Readings:`);
                    console.log(`CO2: ${message.formattedReadings.co2}`);
                    console.log(`Temperature: ${message.formattedReadings.temperature}`);
                    console.log(`Humidity: ${message.formattedReadings.humidity}`);
                    console.log(`Pressure: ${message.formattedReadings.pressure}`);
                    
                    // Post to server
                    await postToServer(message.data);
                    resolve('success');
                } else {
                    reject(new Error(message.error));
                }
            }
            worker.terminate();
        });

        worker.on('error', (error) => {
            clearTimeout(timeoutId);
            if (!isTerminated) {
                isTerminated = true;
                worker.terminate();
                reject(error);
            }
        });

        worker.on('exit', (code) => {
            clearTimeout(timeoutId);
            if (!isTerminated) {
                isTerminated = true;
                if (code !== 0) {
                    reject(new Error(`Worker stopped with exit code ${code}`));
                }
            }
        });
    });
}

// Modify the main loop
async function main() {
    const POLLING_INTERVAL = 1800000; // 30 minutes
    let lastRunTime = 0;
    
    if (process.env.TEST_EMAIL === 'true') {
        await testEmailConfig();
    }

    while (true) {
        const now = Date.now();
        
        if (now - lastRunTime >= POLLING_INTERVAL) {
            try {
                console.log('Starting new reading cycle...');
                const result = await runWorker();
                
                if (result === 'success') {
                    lastRunTime = now;
                    console.log(`\nWaiting ${POLLING_INTERVAL/60000} minutes until next reading...`);
                } else {
                    await sendErrorEmail(new Error('Failed to get reading'));
                }
            } catch (error) {
                console.error('Error during reading:', error.message);
                await sendErrorEmail(error);
            }
        }
        
        // Short sleep to prevent CPU spinning
        await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL + 5000)); // Add 5 second buffer
    }
}

// Update cleanup to handle worker termination
async function cleanup() {
    console.log('\nCleaning up...');
    // Any active workers will be automatically terminated when the process exits
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