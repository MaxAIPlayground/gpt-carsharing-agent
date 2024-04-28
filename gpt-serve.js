const https = require('https');
const express = require('express');
const axios = require('axios');
const moment = require('moment');
const app = express();
const winston = require('winston');

require('dotenv').config();

// Middleware to parse JSON request bodies
app.use(express.json());

const PORT = process.env.GPT_PORT;
const X_API_KEY = process.env.GPT_X_API_KEY;
const API_HOST = 'https://de1.cantamen.de/casirest/v3';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:124.0) Gecko/20100101 Firefox/124.0';

let defaultHeaders = {
    'X-API-Key': X_API_KEY,
    'User-Agent': USER_AGENT,
    'Origin': 'https://ewi3-gruene-flotte.cantamen.de',
};

// Cache and use the pointsofinterest response if lat/lng/range stay the same
let authTokenCache = null;
let poiCache = {};

const logger = winston.createLogger({
    level: 'error', // Log only error level messages or higher (critical)
    format: winston.format.combine(
        winston.format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss'
        }),
        winston.format.errors({ stack: true }), // To log the stack trace
        winston.format.json()
    ),
    transports: [
        // Define where and how to log messages
        new winston.transports.File({ filename: 'error.log', level: 'error' })
    ]
});

async function getAuthObject() {
    if (authTokenCache) {

        console.log('auth token cache found...');

        return authTokenCache;
    }

    const targetUrl = API_HOST + '/tokens?expand=customerId';

    try {

        const body = {
            storeLogin: false,
            provId: "131",
            login: process.env.GPT_USERNAME,
            credential: process.env.GPT_PASSWORD,
        };

        console.log('Doing /tokens request:', { url: targetUrl, defaultHeaders, body });

        const response = await axios.post(targetUrl, body, {
            headers: defaultHeaders,
            httpsAgent: new https.Agent({
                rejectUnauthorized: false // Caution: Only for development or trusted destinations!
            })
        });

        console.log('Received response from /tokens:', response.data);

        authTokenCache = response.data;

        return response.data;

    } catch (error) {
        console.error('Error during request forwarding to /tokens:', error.message);
        logger.error(error);
        return false;
    }
}

function retryRoute(req, res) {
    console.log('Retrying route...');
    app.handle(req, res);
}

function getAuthHeader(authObject) {
    // Create the base64-encoded authorization header value
    const base64Credentials = Buffer.from(`${authObject.id}:${authObject.customerId}`).toString('base64');

    return `Basic ${base64Credentials}`;
}

function getCarsForLogging(poiData, bookingproposalsData) {
    let cars = [];

    // Flatten all bookees into a single array including their distance from the user
    poiData.forEach(item => {
        item.places.forEach(place => {
            place.bookees.forEach(bookee => {
                cars.push({ ...bookee, distance: place.distance });
            });
        });
    });
    const availableCarIds = new Set(bookingproposalsData.map(booking => booking.bookeeId));

    return cars.filter(car => availableCarIds.has(car.id)).slice(0, 15);
}

function getCarsFiltered(poiData, bookingproposalsData, bookingDurationHours) {
    console.log('bookingDurationHours: ' + bookingDurationHours);

    let cars = [];

    // Flatten all bookees into a single array including their distance from the user
    poiData.forEach(item => {
        item.places.forEach(place => {
            place.bookees.forEach(bookee => {
                cars.push({ ...bookee, distance: place.distance });
            });
        });
    });

    // Filter cars based on availability in bookingproposalsData
    const availableCarIds = new Set(bookingproposalsData.map(booking => booking.bookeeId));
    cars = cars.filter(car => availableCarIds.has(car.id));

    // Define priority map and cutoff distances
    const priorityMap = { 'XS': 1, 'S': 2, 'M': 3, 'M (Elektro)': 3, 'L': 4, 'XL': 5 };

    const distanceForConvenienceCutOff = 200;

    // Adjust selection based on booking duration
    if (bookingDurationHours < 3) {
        // Prefer nearest cars if the booking is for less than 3 hours, with special consideration for 'S' within 200m
        cars.sort((a, b) => {
            const typeA = priorityMap[a.bookeeType.name];
            const typeB = priorityMap[b.bookeeType.name];
            const distDiff = a.distance - b.distance;

            // Check for 'XS' vs 'S' special condition
            if ((typeA === 1 && typeB === 2) || (typeA === 2 && typeB === 1)) {
                // Prefer 'S' within 200m over 'XS' beyond 200m
                if (typeA === 2 && a.distance <= distanceForConvenienceCutOff && b.distance > distanceForConvenienceCutOff) return -1;

                // Prefer 'S' within 200m over 'XS' beyond 200m
                if (typeB === 2 && b.distance <= distanceForConvenienceCutOff && a.distance > distanceForConvenienceCutOff) return 1;
            }

            // Prioritize 'XS' cars explicitly when they compete with any other type
            if (typeA === 1 || typeB === 1) {
                if (typeA === 1 && typeB !== 1) return -1; // Always prioritize 'XS' over others unless above condition met
                if (typeB === 1 && typeA !== 1) return 1;  // Always prioritize 'XS' over others unless above condition met
            }

            // Compare types if both are 'XS' or 'S'
            if (typeA <= 2 && typeB <= 2) {
                return distDiff;  // Prefer closer car if both are 'XS' or 'S'
            }

            // General case: sort by type then by distance
            if (typeA !== typeB) return typeA - typeB;
            return distDiff;
        });
    } else {
        // For longer bookings, prioritize cost over proximity
        cars.sort((a, b) => {
            const typeA = priorityMap[a.bookeeType.name];
            const typeB = priorityMap[b.bookeeType.name];
            return typeA - typeB;
        });
    }

    // Return only the top 5 cars
    return cars.slice(0, 5);
}

// Auth route
app.get('/gpt-carsharing-agent/auth', async (req, res) => {
    console.log('Received request:', { headers: req.headers, body: req.body });
    res.json(getAuthObject());
});

// Get a list of available cars (pointsofinterest)
app.get('/gpt-carsharing-agent/cars', async (req, res) => {

    console.log('Received request:', { headers: req.headers, params: req.query });
    console.log('Full URL:', req.protocol + '://' + req.get('host') + req.originalUrl);
    console.log('Query parameters:', req.query);

    let targetUrl = API_HOST + '/pointsofinterest';

    const { range = 1000, lat = '47.9983', lng = '7.8423', start, end } = req.query;
    const cacheKey = `${lat}_${lng}_${range}`;
    const currentTime = Date.now();

    try {
        const authObj = await getAuthObject();
        const authHeader = getAuthHeader(authObj);

        let poiData, bookingproposalsData;

        // Check if we have valid cached data for points of interest
        if (poiCache[cacheKey] && (currentTime - poiCache[cacheKey].timestamp) < 86400000) { // 86400000ms = 24 hours
            console.log('Using cached data for /pointsofinterest');
            poiData = poiCache[cacheKey].data;
        } else {
            console.log('Fetching new data for /pointsofinterest');
            const poiResponse = await axios.get(`${API_HOST}/pointsofinterest`, {
                params: {
                    expand: 'place.bookee.bookeeType',
                    placeIsFixed: true,
                    sort: 'distance',
                    lat,
                    lng,
                    range,
                    start,
                    end,
                },
                headers: {
                    ...defaultHeaders,
                    'Authorization': authHeader,
                },
                httpsAgent: new https.Agent({ rejectUnauthorized: false })
            });

            poiData = poiResponse.data;
            poiCache[cacheKey] = { data: poiData, timestamp: currentTime }; // Cache the new data
            console.log('Received and cached new data from /pointsofinterest');
        }

        // Fetching bookingproposals
        console.log('Fetching data from /bookingproposals');
        const bookingResponse = await axios.get(`${API_HOST}/bookingproposals`, {
            params: {
                expand: 'bookeeId',
                lat,
                lng,
                range,
                start,
                end,
            },
            headers: {
                ...defaultHeaders,
                'Authorization': authHeader,
            },
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });

        bookingproposalsData = bookingResponse.data;
        console.log(`Received response from /bookingproposals. Found ${bookingproposalsData.length} items.`);

        // Filter and sort cars based on the combined data from both endpoints
        const startTime = moment(start);
        const endTime = moment(end);
        const bookingDurationHours = endTime.diff(startTime, 'hours');

        const cars = getCarsFiltered(poiData, bookingproposalsData, bookingDurationHours);
        const carsForLogging = getCarsForLogging(poiData, bookingproposalsData);
        console.log('Cars for logging:', carsForLogging);

        res.json(cars);

    } catch (error) {

        // If unanauthorized, remove the authToken cache
        if (error.status === 401) {
            authTokenCache = null;
            retryRoute(req, res);
            return;
        }

        console.error('Error in /cars request:', error.message);
        logger.error(error);
        res.status(500).json({ error: 'Error in /cars request', details: error.message });
    }
});

// Make a reservation (prelimbookings)
app.get('/gpt-carsharing-agent/reservation', async (req, res) => {

    console.log('Received request:', { headers: req.headers, params: req.query });
    console.log('Full URL:', req.protocol + '://' + req.get('host') + req.originalUrl);
    console.log('Query parameters:', req.query);

    try {
        const authObj = await getAuthObject();
        const authHeader = getAuthHeader(authObj);

        const queryParams = {
            expand: ['bookeeId', 'customerId', 'price.bookeeId', 'bookingId', 'addProp.addPropType', 'addPropType'],
        };

        console.log('Query Params:', queryParams);

        const data = {
            bookeeId: req.query.bookeeId,
            timeRange: {
                start: req.query.start,
                end: req.query.end,
            },
        };

        console.log('Data:', data);

        const response = await axios.post(`${API_HOST}/prelimbookings`, data, {
            params: queryParams,
            paramsSerializer: params => {
                // This should return a string
                return Object.keys(params)
                    .map(key => {
                        if (Array.isArray(params[key])) {
                            return params[key].map(value => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
                        }
                        return `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`;
                    })
                    .join('&');
            },
            headers: {
                ...defaultHeaders,
                'Authorization': authHeader,
            },
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });

        res.json(response.data);

    } catch (error) {
        console.error('Error in /prelimbookings request:', error.message);
        logger.error(error);
        res.status(400).json({ error: 'Error in /prelimbookings request', details: error.message });
    }
});

// Create a booking (prelimbookings/{reservationId}/confirm)
app.get('/gpt-carsharing-agent/book', async (req, res) => {
    console.log('Received request:', { headers: req.headers, params: req.query });
    console.log('Full URL:', req.protocol + '://' + req.get('host') + req.originalUrl);
    console.log('Query parameters:', req.query);

    try {
        const authObj = await getAuthObject();
        const authHeader = getAuthHeader(authObj);
        const reservationId = req.query.reservationId;
        console.log('using reservation id: ' + reservationId);

        if (!reservationId) {
            return res.status(500).json({ error: 'no reservation id given' });
        }

        const response = await axios.post(`${API_HOST}/prelimbookings/${reservationId}/confirm`, {}, {
            headers: {
                ...defaultHeaders,
                'Authorization': authHeader,
            },
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });

        res.json(response.data);

    } catch (error) {
        console.error('Error in /prelimbookings/{reservationId}/confirm request:', error.message);
        logger.error(error);
        res.status(400).json({ error: 'Error in /prelimbookings/{reservationId}/confirm request', details: error.message });
    }
});

// Cancel a booking (bookings/{bookingId}/cancel)
app.get('/gpt-carsharing-agent/cancel', async (req, res) => {
    console.log('Received request:', { headers: req.headers, params: req.query });
    console.log('Full URL:', req.protocol + '://' + req.get('host') + req.originalUrl);
    console.log('Query parameters:', req.query);

    try {
        const authObj = await getAuthObject();
        const authHeader = getAuthHeader(authObj);
        const bookingId = req.query.bookingId;
        console.log('using booking id: ' + bookingId);

        if (!bookingId) {
            return res.status(500).json({ error: 'no booking id given' });
        }

        const response = await axios.post(`${API_HOST}/bookings/${bookingId}/cancel`, {}, {
            headers: {
                ...defaultHeaders,
                'Authorization': authHeader,
            },
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });

        res.json(response.data);

    } catch (error) {
        console.error('Error in /bookings/{bookingId}/cancel request:', error.message);
        logger.error(error);
        res.status(400).json({ error: 'Error in /bookings/{bookingId}/cancel request', details: error.message });
    }
});

// Confirm the cancellation of a booking (prelimbookings/{cancellationId}/confirm)
app.get('/gpt-carsharing-agent/cancel-confirm', async (req, res) => {
    console.log('Received request:', { headers: req.headers, params: req.query });
    console.log('Full URL:', req.protocol + '://' + req.get('host') + req.originalUrl);
    console.log('Query parameters:', req.query);

    try {
        const authObj = await getAuthObject();
        const authHeader = getAuthHeader(authObj);
        const cancellationId = req.query.cancellationId;
        console.log('using cancellation id: ' + cancellationId);

        if (!cancellationId) {
            return res.status(500).json({ error: 'no cancellation id given' });
        }

        const response = await axios.post(`${API_HOST}/prelimbookings/${cancellationId}/confirm`, {}, {
            headers: {
                ...defaultHeaders,
                'Authorization': authHeader,
            },
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });

        res.json(response.data);

    } catch (error) {
        console.error('Error in /prelimbookings/{cancellationId}/confirm request:', error.message);
        logger.error(error);
        res.status(400).json({ error: 'Error in /prelimbookings/{cancellationId}/cconfirmancel request', details: error.message });
    }
});

// Retrieve the current bookings (bookings)
app.get('/gpt-carsharing-agent/bookings', async (req, res) => {
    console.log('Received request:', { headers: req.headers, params: req.query });
    console.log('Full URL:', req.protocol + '://' + req.get('host') + req.originalUrl);
    console.log('Query parameters:', req.query);

    try {
        const authObj = await getAuthObject();
        const authHeader = getAuthHeader(authObj);

        const dateEnd = new Date((new Date).getTime() + 4 * 7 * 24 * 60 * 60 * 1000); // 4 weeks

        const queryParams = {
            changeable: true, // this seems to discard cancelled bookings which is what we want
            start: (new Date()).toISOString(),
            sort: 'timeRange.start,timeRange.end,id',
            expand: [
                'bookeeId',
                'customerId',
                'price.bookeeId',
                'changeInfoId',
                'changePossibilityId',
                'geoPosition',
                'flexInfo.placeId',
                'flexInfo.slot.placeId',
                'addProp.addPropType',
                'fuelCard.fuelCardIssuer',
                'entrance',
            ]
        };

        console.log('Query Params:', queryParams);

        const response = await axios.get(`${API_HOST}/bookings`, {
            params: queryParams,
            paramsSerializer: params => {
                // This should return a string
                return Object.keys(params)
                    .map(key => {
                        if (Array.isArray(params[key])) {
                            return params[key].map(value => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
                        }
                        return `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`;
                    })
                    .join('&');
            },
            headers: {
                ...defaultHeaders,
                'Authorization': authHeader,
            },
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });

        res.json(response.data);

    } catch (error) {
        console.error('Error in /bookings request:', error.message);
        logger.error(error);
        res.status(400).json({ error: 'Error in /bookings request', details: error.message });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
