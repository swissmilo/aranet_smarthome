const { parentPort } = require('worker_threads');
const noble = require('@abandonware/noble');
require('dotenv').config();

let aranet4Device = null;

function parseCurrentReadings(data) {
    if (!Buffer.isBuffer(data)) {
        throw new Error('Invalid data: not a buffer');
    }
    
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
        throw new Error(`Failed to parse sensor data: ${error.message}`);
    }
}

async function startScanning() {
    return new Promise((resolve, reject) => {
        let isConnected = false;

        const handleStateChange = async (state) => {
            if (state === 'poweredOn' && !isConnected) {
                try {
                    await noble.startScanningAsync([], false);
                } catch (error) {
                    reject(error);
                }
            }
        };

        const handleDiscover = async (peripheral) => {
            const name = peripheral.advertisement.localName;
            
            if (name?.includes('Aranet4') && !isConnected) {
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

async function connectAndRead(peripheral) {
    try {
        await peripheral.connectAsync();
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const services = await peripheral.discoverServicesAsync();
        const aranetService = services.find(s => s.uuid === 'fce0');
        if (!aranetService) {
            throw new Error('Aranet service not found');
        }
        
        const characteristics = await aranetService.discoverCharacteristicsAsync();
        const currentReadingsChar = characteristics.find(
            c => c.uuid === 'f0cd150395da4f4b9ac8aa55d312af0c'
        );
        
        if (!currentReadingsChar) {
            throw new Error('Current readings characteristic not found');
        }

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
        
        // Clean disconnect
        await peripheral.disconnectAsync();
        
        return {
            readings,
            formattedReadings: {
                time: new Date(readings.timestamp).toLocaleTimeString(),
                co2: `${readings.co2} ppm`,
                temperature: `${readings.temperature.toFixed(1)}°C`,
                humidity: `${readings.humidity}%`,
                pressure: `${readings.pressure.toFixed(1)} hPa`
            }
        };
    } catch (error) {
        if (peripheral.state === 'connected') {
            await peripheral.disconnectAsync();
        }
        throw error;
    }
}

async function performReading() {
    try {
        const peripheral = await startScanning();
        const result = await connectAndRead(peripheral);
        parentPort.postMessage({ 
            success: true, 
            data: result.readings,
            formattedReadings: result.formattedReadings
        });
    } catch (error) {
        parentPort.postMessage({ success: false, error: error.message });
    }
}

// Start the reading process when the worker starts
performReading(); 