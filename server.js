const { Datastore } = require("@google-cloud/datastore");
const datastore = new Datastore();

const express = require("express");
const app = express();
app.use(express.json());

const router = express.Router();
app.use("/", router);
app.enable('trust proxy');
app.use(express.static('public'));

// const appUrl = "http://localhost:3000";
const appUrl = "https://project-hoffr.uw.r.appspot.com";
const acceptType = 'application/json';

// Listen to the App Engine-specified port, or 3000 otherwise
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}...`);
});

const { google } = require('googleapis');
const people = google.people('v1');

/* ------------- Authentication Functions & Routes ------------- */

const oauth2Client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    appUrl + '/oauth'
);
// set auth2Client as a global default
google.options({
    auth: oauth2Client
});

const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: 'https://www.googleapis.com/auth/userinfo.profile',
    include_granted_scopes: true
});

// create new user
async function createUser(name, user_id) {
    const key = datastore.key(["User"]);

    const allocatedId = await datastore.transaction().allocateIds(key, 1);
    const entityId = parseInt(allocatedId[0][0].id);

    // create a new user object
    const newUser = {
        key: datastore.key(["User", entityId]),
        data: {
            name: name,
            user_id: user_id
        },
    };

    // save the user
    await datastore.save(newUser);
}

// initial login request; redirected to Google's OAuth server
app.get('/authReq', (req, res) => {
    return res.redirect(authUrl);
});

// google auth redirect on success
app.get('/oauth', async (req, res) => {
    const auth = await oauth2Client.getToken(req.query.code)
    oauth2Client.setCredentials(auth.tokens);

    // get user google profile
    let user = await people.people.get({
        resourceName: 'people/me',
        personFields: 'emailAddresses,names',
    });
    let userId = user.data.resourceName.split('people/')[1];
    let userName = user.data.names[0].displayName;

    // check if authenticated user has a user account
    const query = datastore.createQuery("User").filter('user_id', '=', userId);
    const [results] = await datastore.runQuery(query);

    if (results.length !== 0) {
        userId = results[0].user_id;
        userName = results[0].name;
    } else {
        await createUser(userName, userId);
    }
    return res.send(`
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="UTF-8" />
                <meta http-equiv="X-UA-Compatible" content="IE=edge" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <link rel="stylesheet" href="styles.css" />
                <title>CS493 Project - hoffr</title>
            </head>
            <body>
                <div style="display:flex;flex-direction:column;justify-content:center;align-items:center;word-break:break-all;">
                    <h1>User Account Info</h1>
                    <div>Welcome ${userName}!</div><br>
                    <div><b>Unique User ID:</b></div>
                    <div>${userId}</div><br>
                    <div><b>Issued JWT:</b></div>
                    <div>${auth.tokens.id_token}</div><br>
                    <div><a href="${appUrl}">Return Home</a></div>
                </div>
            </body>
        </html>`);
});

// verify a jwt with google auth library
async function verify(jwt) {
    let clientID = "660160479572-ittvsqcog98fk0ciumnaph3881f7us2n.apps.googleusercontent.com";
    const { OAuth2Client } = require('google-auth-library');
    const client = new OAuth2Client(clientID);

    try {
        let ticket = await client.verifyIdToken({
            idToken: jwt,
            audience: clientID,
        });
        return ticket.getPayload();
    } catch (error) {
        return false;
    }
}

/* ------------- Model Functions ------------- */

// get list of users
async function getUsers() {
    const query = datastore.createQuery("User");
    const [results] = await datastore.runQuery(query);

    let users = [];
    results.forEach(result => {
        let user = {
            user_id: result.user_id
        };
        users.push(user);
    })
    return users;
}

// create a new car
async function createCar(make, model, color, owner, url) {
    const key = datastore.key(["Car"]);
    const allocatedId = await datastore.transaction().allocateIds(key, 1);
    const entityId = allocatedId[0][0].id;

    // create a new car object
    const newCar = {
        key: datastore.key(["Car", parseInt(entityId)]),
        data: {
            make: make,
            model: model,
            color: color,
            owner: { user_id: owner },
            garage: null
        }
    };
    // save the car
    await datastore.save(newCar);

    let savedCar = {
        id: parseInt(entityId),
        make: newCar.data.make,
        model: newCar.data.model,
        color: newCar.data.color,
        owner: newCar.data.owner,
        garage: newCar.data.garage,
        self: url + '/' + entityId
    };
    return savedCar;
}

// get all cars for a specific user
async function getCars(user_id, url, pageCursor) {
    let query = datastore.createQuery("Car").filter('owner.user_id', '=', user_id).limit(5);

    // if pageCursor exists, set query start to pageCursor
    if (pageCursor) {
        query = query.start(pageCursor);
    }
    const result = await datastore.runQuery(query);
    let results = result[0];
    let info = result[1];

    let cars = [];
    results.forEach(result => {
        let car = {
            id: parseInt(result[Datastore.KEY].id),
            make: result.make,
            model: result.model,
            color: result.color,
            owner: result.owner,
            garage: result.garage ?
                { id: parseInt(result.garage.id), self: url + '/garages/' + result.garage.id } : result.garage,
            self: url + '/cars/' + result[Datastore.KEY].id
        };
        cars.push(car);
    })

    // if there are more results after pagination, provide link
    if (info.moreResults !== Datastore.NO_MORE_RESULTS) {
        return {
            results: cars.length,
            cars: cars,
            next: url + "/cars/page/" + encodeURIComponent(info.endCursor)
        };
    }
    return {
        results: cars.length,
        cars: cars,
        next: "No more results"
    };
}

// get a car by id
async function getCar(user_id, car_id, url) {
    const query = datastore.createQuery("Car")
        .filter('__key__', '=', datastore.key(["Car", parseInt(car_id)]))
        .filter('owner.user_id', '=', user_id);
    const [result] = await datastore.runQuery(query);

    let car;
    if (result.length !== 0) {
        car = {
            id: parseInt(result[0][Datastore.KEY].id),
            make: result[0].make,
            model: result[0].model,
            color: result[0].color,
            owner: result[0].owner,
            garage: result[0].garage ?
                { id: parseInt(result[0].garage.id), self: url + '/garages/' + result[0].garage.id } : result[0].garage,
            self: url + '/cars/' + car_id
        };
    }
    return car;
}

// update a car by id
async function updateCar(user_id, car_id, make, model, color, url) {
    const query = datastore.createQuery("Car")
        .filter('__key__', '=', datastore.key(["Car", parseInt(car_id)]))
        .filter('owner.user_id', '=', user_id);
    const [result] = await datastore.runQuery(query);

    let car;
    if (result.length !== 0) {
        // update the car object
        make ? result[0].make = make : result[0].make;
        model ? result[0].model = model : result[0].model;
        color ? result[0].color = color : result[0].color;
        await datastore.save(result[0]);

        car = {
            id: parseInt(result[0][Datastore.KEY].id),
            make: result[0].make,
            model: result[0].model,
            color: result[0].color,
            owner: result[0].owner,
            garage: result[0].garage ?
                { id: parseInt(result[0].garage.id), self: url + '/garages/' + result[0].garage.id } : result[0].garage,
            self: url + '/cars/' + car_id
        };
    }
    return car;
}

// delete a car by id
async function deleteCar(user_id, car_id) {
    const query = datastore.createQuery("Car")
        .filter('__key__', '=', datastore.key(["Car", parseInt(car_id)]))
        .filter('owner.user_id', '=', user_id);
    const [result] = await datastore.runQuery(query);

    if (result.length !== 0) {
        if (result[0].garage) { // car is in a garage
            return 400;
        } else {
            const carKey = datastore.key(["Car", parseInt(car_id)]);
            await datastore.delete(carKey);
            return 204;
        }
    }
    return 404;
}

// create a new garage
async function createGarage(name, city, state, url) {
    const key = datastore.key(["Garage"]);
    const allocatedId = await datastore.transaction().allocateIds(key, 1);
    const entityId = allocatedId[0][0].id;

    // create a new garage object
    const newGarage = {
        key: datastore.key(["Garage", parseInt(entityId)]),
        data: {
            name: name,
            city: city,
            state: state,
            cars: []
        }
    };
    // save the garage
    await datastore.save(newGarage);

    let savedGarage = {
        id: parseInt(entityId),
        name: newGarage.data.name,
        city: newGarage.data.city,
        state: newGarage.data.state,
        cars: newGarage.data.cars,
        self: url + '/' + entityId
    };
    return savedGarage;
}

// get all garages
async function getGarages(url, pageCursor) {
    let query = datastore.createQuery("Garage").limit(5);

    // if pageCursor exists, set query start to pageCursor
    if (pageCursor) {
        query = query.start(pageCursor);
    }
    const result = await datastore.runQuery(query);
    let results = result[0];
    let info = result[1];

    let garages = [];
    results.forEach(result => {
        let carList = [];
        if (result.cars) {
            for (car of result.cars) {
                carList.push({
                    id: parseInt(car.id),
                    self: url + '/cars/' + car.id
                })
            }
        }
        let garage = {
            id: parseInt(result[Datastore.KEY].id),
            name: result.name,
            city: result.city,
            state: result.state,
            cars: carList,
            self: url + '/garages/' + result[Datastore.KEY].id
        };
        garages.push(garage);
    })

    // if there are more results after pagination, provide link
    if (info.moreResults !== Datastore.NO_MORE_RESULTS) {
        return {
            results: garages.length,
            garages: garages,
            next: url + "/garages/page/" + encodeURIComponent(info.endCursor)
        };
    }
    return {
        results: garages.length,
        garages: garages,
        next: "No more results"
    };
}

// get a garage by id
async function getGarage(garage_id, url) {
    const query = datastore.createQuery("Garage").filter('__key__', '=', datastore.key(["Garage", parseInt(garage_id)]));
    const [result] = await datastore.runQuery(query);

    let garage;
    if (result.length !== 0) {
        let carList = [];
        if (result[0].cars) {
            for (car of result[0].cars) {
                carList.push({
                    id: parseInt(car.id),
                    self: url + '/cars/' + car.id
                })
            }
        }
        garage = {
            id: parseInt(result[0][Datastore.KEY].id),
            name: result[0].name,
            city: result[0].city,
            state: result[0].state,
            cars: carList,
            self: url + '/garages/' + garage_id
        };
    }
    return garage;
}

// update a garage by id
async function updateGarage(garage_id, name, city, state, url) {
    const query = datastore.createQuery("Garage").filter('__key__', '=', datastore.key(["Garage", parseInt(garage_id)]));
    const [result] = await datastore.runQuery(query);

    let garage;
    if (result.length !== 0) {
        // update the garage object
        name ? result[0].name = name : result[0].name;
        city ? result[0].city = city : result[0].city;
        state ? result[0].state = state : result[0].state;
        await datastore.save(result[0]);

        let carList = [];
        if (result[0].cars) {
            for (car of result[0].cars) {
                carList.push({
                    id: parseInt(car.id),
                    self: url + '/cars/' + car.id
                })
            }
        }
        garage = {
            id: parseInt(result[0][Datastore.KEY].id),
            name: result[0].name,
            city: result[0].city,
            state: result[0].state,
            cars: carList,
            self: url + '/garages/' + garage_id
        };
    }
    return garage;
}

// delete a garage by id
async function deleteGarage(garage_id) {
    const query = datastore.createQuery("Garage")
        .filter('__key__', '=', datastore.key(["Garage", parseInt(garage_id)]));
    const [result] = await datastore.runQuery(query);

    if (result.length !== 0) {
        if (result[0].cars.length > 0) { // garage has cars
            return 400;
        } else {
            const garageKey = datastore.key(["Garage", parseInt(garage_id)]);
            await datastore.delete(garageKey);
            return 204;
        }
    }
    return 404;
}

// put a car in a garage
async function addCarToGarage(user_id, car_id, garage_id) {
    let query = datastore.createQuery("Car").filter('__key__', '=', datastore.key(["Car", parseInt(car_id)]));
    const [car] = await datastore.runQuery(query);

    query = datastore.createQuery("Garage").filter('__key__', '=', datastore.key(["Garage", parseInt(garage_id)]));
    const [garage] = await datastore.runQuery(query);

    if (car.length !== 0 && garage.length !== 0) {
        if (car[0].owner) {
            if (car[0].owner.user_id !== user_id) { // car does not belong to the user
                return 403;
            }
        }
        if (!car[0].garage) { // make sure car is not in a garage already
            let carList = garage[0].cars;
            carList.push({ id: car[0][Datastore.KEY].id });

            // create a new garage object
            const newGarage = {
                key: datastore.key(["Garage", parseInt(garage_id)]),
                data: {
                    name: garage[0].name,
                    city: garage[0].city,
                    state: garage[0].state,
                    cars: carList
                }
            };
            // save the garage
            await datastore.save(newGarage);

            // create a new car object
            const newCar = {
                key: datastore.key(["Car", parseInt(car_id)]),
                data: {
                    make: car[0].make,
                    model: car[0].model,
                    color: car[0].color,
                    owner: car[0].owner,
                    garage: { id: garage[0][Datastore.KEY].id }
                }
            };
            // save the car
            await datastore.save(newCar);
            return 204;
        }
        return 400;
    }
    return 404;
}

// delete a car from a garage
async function removeCarFromGarage(user_id, car_id, garage_id) {
    let query = datastore.createQuery("Car").filter('__key__', '=', datastore.key(["Car", parseInt(car_id)]));
    const [car] = await datastore.runQuery(query);

    query = datastore.createQuery("Garage").filter('__key__', '=', datastore.key(["Garage", parseInt(garage_id)]));
    const [garage] = await datastore.runQuery(query);

    if (car.length !== 0 && garage.length !== 0) {
        if (car[0].owner) {
            if (car[0].owner.user_id !== user_id) { // car does not belong to the user
                return 403;
            }
        }
        if (car[0].garage) {
            if (car[0].garage.id === garage_id) { // make sure car is in the provided garage
                let carList = garage[0].cars;
                carList = carList.filter(current => current.id != car[0][Datastore.KEY].id);

                // create a new garage object
                const newGarage = {
                    key: datastore.key(["Garage", parseInt(garage_id)]),
                    data: {
                        name: garage[0].name,
                        city: garage[0].city,
                        state: garage[0].state,
                        cars: carList
                    }
                };
                // save the garage
                await datastore.save(newGarage);

                // create a new car object
                const newCar = {
                    key: datastore.key(["Car", parseInt(car_id)]),
                    data: {
                        make: car[0].make,
                        model: car[0].model,
                        color: car[0].color,
                        owner: car[0].owner,
                        garage: null
                    }
                };
                // save the car
                await datastore.save(newCar);
                return 204;
            }
        }
        return 400;
    }
    return 404;
}

/* ------------- Controller Functions ------------- */

// get all users
router.get("/users", function (req, res) {
    let type = 'application/json';
    if (!req.accepts(acceptType)) {
        return res.status(406).json({ Error: `Unsupported Accept MIME type ${req.accepts()}. Must accept ${acceptType}` });
    }
    getUsers().then((result) => {
        return res.status(200).json({ users: result });
    });
});

// create a new car
router.post("/cars", function (req, res) {
    if (!req.accepts(acceptType)) {
        return res.status(406).json({ Error: `Unsupported Accept MIME type ${req.accepts()}. Must accept ${acceptType}` });
    }
    // check for authorization in header of request
    let requestAuth = req.headers.authorization;
    if (requestAuth === undefined) {
        // if no auth, return 401
        return res.status(401).send();
    } else {
        requestAuth = requestAuth.split(" ")[1];
    }
    verify(requestAuth).then((authorization) => {
        if (authorization) {
            // ensure included attributes are valid
            let validAttributes = true;
            const keys = Object.keys(req.body);
            if (!(keys.length === 3 && keys.includes('make') && keys.includes('model') && keys.includes('color'))) {
                validAttributes = false;
            }
            if (validAttributes) {
                const url = req.protocol + '://' + req.hostname + (process.env.PORT ? '' : ':' + PORT) + req.originalUrl;
                createCar(req.body.make, req.body.model, req.body.color, authorization.sub, url).then((car) => {
                    // id was verified and car created
                    return res.status(201).json(car);
                });
            } else {
                return res.status(400).json({ Error: "Cars can only have attributes make, model, and color; all required" });
            }
        } else {
            // provided auth id was not verified
            return res.status(401).send();
        }
    })
});

// get all cars for a user
router.get("/cars", function (req, res) {
    if (!req.accepts(acceptType)) {
        return res.status(406).json({ Error: `Unsupported Accept MIME type ${req.accepts()}. Must accept ${acceptType}` });
    }
    // check for authorization in header of request
    let requestAuth = req.headers.authorization;
    if (requestAuth === undefined) {
        // if no auth, return 401
        return res.status(401).send();
    } else {
        requestAuth = requestAuth.split(" ")[1];
    }
    verify(requestAuth).then((authorization) => {
        if (authorization) {
            const url = req.protocol + '://' + req.hostname + (process.env.PORT ? '' : ':' + PORT);
            let cursor = null;
            getCars(authorization.sub, url, cursor).then((cars) => {
                return res.status(200).json(cars);
            });
        } else {
            // provided auth id was not verified
            return res.status(401).send();
        }
    })
});

// get page of cars for a user
router.get("/cars/page/:cursor?", function (req, res) {
    if (!req.accepts(acceptType)) {
        return res.status(406).json({ Error: `Unsupported Accept MIME type ${req.accepts()}. Must accept ${acceptType}` });
    }
    // check for authorization in header of request
    let requestAuth = req.headers.authorization;
    if (requestAuth === undefined) {
        // if no auth, return 401
        return res.status(401).send();
    } else {
        requestAuth = requestAuth.split(" ")[1];
    }
    verify(requestAuth).then((authorization) => {
        if (authorization) {
            const url = req.protocol + '://' + req.hostname + (process.env.PORT ? '' : ':' + PORT);
            getCars(authorization.sub, url, req.params.cursor).then((cars) => {
                return res.status(200).json(cars);
            });
        } else {
            // provided auth id was not verified
            return res.status(401).send();
        }
    })
});

// get a single car by id
router.get("/cars/:car_id", function (req, res) {
    if (!req.accepts(acceptType)) {
        return res.status(406).json({ Error: `Unsupported Accept MIME type ${req.accepts()}. Must accept ${acceptType}` });
    }
    // check for authorization in header of request
    let requestAuth = req.headers.authorization;
    if (requestAuth === undefined) {
        // if no auth, return 401
        return res.status(401).send();
    } else {
        requestAuth = requestAuth.split(" ")[1];
    }
    verify(requestAuth).then((authorization) => {
        if (authorization) {
            const url = req.protocol + '://' + req.hostname + (process.env.PORT ? '' : ':' + PORT);
            getCar(authorization.sub, req.params.car_id, url).then((car) => {
                // the requested car does not exist
                if (!car) {
                    return res.status(404).json({ Error: "No car with this car_id exists for the authenticated user" });
                }
                // the requested car exists
                else {
                    return res.status(200).json(car);
                }
            });
        } else {
            // provided auth id was not verified
            return res.status(401).send();
        }
    })
});

// update car by id
router.patch("/cars/:car_id", function (req, res) {
    if (!req.accepts(acceptType)) {
        return res.status(406).json({ Error: `Unsupported Accept MIME type ${req.accepts()}. Must accept ${acceptType}` });
    }
    // check for authorization in header of request
    let requestAuth = req.headers.authorization;
    if (requestAuth === undefined) {
        // if no auth, return 401
        return res.status(401).send();
    } else {
        requestAuth = requestAuth.split(" ")[1];
    }
    verify(requestAuth).then((authorization) => {
        if (authorization) {
            // ensure included attributes are valid
            let validAttributes = true;
            for (key of Object.keys(req.body)) {
                if (!(key === 'make' || key === 'model' || key === 'color')) {
                    validAttributes = false;
                    break;
                }
            }
            if (validAttributes) {
                const url = req.protocol + '://' + req.hostname + (process.env.PORT ? '' : ':' + PORT);
                updateCar(authorization.sub, req.params.car_id, req.body.make, req.body.model, req.body.color, url).then((car) => {
                    // the requested car does not exist
                    if (!car) {
                        return res.status(404).json({ Error: "No car with this car_id exists for the authenticated user" });
                    }
                    // the requested car exists
                    else {
                        return res.status(200).json(car);
                    }
                });
            } else {
                return res.status(400).json({ Error: "Only make, model, and/or color can be updated for a car" });
            }
        } else {
            // provided auth id was not verified
            return res.status(401).send();
        }
    })
});

// delete car by id
router.delete("/cars/:car_id", function (req, res) {
    // check for authorization in header of request
    let requestAuth = req.headers.authorization;
    if (requestAuth === undefined) {
        // if no auth, return 401
        return res.status(401).send();
    } else {
        requestAuth = requestAuth.split(" ")[1];
    }
    verify(requestAuth).then((authorization) => {
        if (authorization) {
            deleteCar(authorization.sub, req.params.car_id).then((status) => {
                switch (status) {
                    case 204:
                        return res.status(204).send();
                    case 400:
                        return res.status(400).json({ Error: "Cannot delete a car that is in a garage" })
                    case 404:
                        return res.status(404).json({ Error: "No car with this car_id exists for the authenticated user" });
                }
            });
        } else {
            // provided auth id was not verified
            return res.status(401).send();
        }
    })
});

// handle delete request to /cars
router.delete("/cars", function (req, res) {
    const url = req.protocol + '://' + req.hostname + (process.env.PORT ? '' : ':' + PORT) + req.originalUrl;
    res.set('Accept', 'GET, POST');
    return res.status(405).json({ Error: `The ${req.method} method is not allowed on ${url}` });
});

// create a new garage
router.post("/garages", function (req, res) {
    if (!req.accepts(acceptType)) {
        return res.status(406).json({ Error: `Unsupported Accept MIME type ${req.accepts()}. Must accept ${acceptType}` });
    }
    // ensure included attributes are valid
    let validAttributes = true;
    const keys = Object.keys(req.body);
    if (!(keys.length === 3 && keys.includes('name') && keys.includes('city') && keys.includes('state'))) {
        validAttributes = false;
    }
    if (validAttributes) {
        const url = req.protocol + '://' + req.hostname + (process.env.PORT ? '' : ':' + PORT) + req.originalUrl;
        createGarage(req.body.name, req.body.city, req.body.state, url).then((garage) => {
            return res.status(201).json(garage);
        });
    } else {
        return res.status(400).json({ Error: "Garages can only have attributes name, city, and state; all required" });
    }
});

// get all garages
router.get("/garages", function (req, res) {
    if (!req.accepts(acceptType)) {
        return res.status(406).json({ Error: `Unsupported Accept MIME type ${req.accepts()}. Must accept ${acceptType}` });
    }
    const url = req.protocol + '://' + req.hostname + (process.env.PORT ? '' : ':' + PORT);
    let cursor = null;
    getGarages(url, cursor).then((garages) => {
        return res.status(200).json(garages);
    });
});

// get page of garages
router.get("/garages/page/:cursor?", function (req, res) {
    if (!req.accepts(acceptType)) {
        return res.status(406).json({ Error: `Unsupported Accept MIME type ${req.accepts()}. Must accept ${acceptType}` });
    }
    const url = req.protocol + '://' + req.hostname + (process.env.PORT ? '' : ':' + PORT);
    getGarages(url, req.params.cursor).then((garages) => {
        return res.status(200).json(garages);
    });
});

// get a single garage by id
router.get("/garages/:garage_id", function (req, res) {
    if (!req.accepts(acceptType)) {
        return res.status(406).json({ Error: `Unsupported Accept MIME type ${req.accepts()}. Must accept ${acceptType}` });
    }
    const url = req.protocol + '://' + req.hostname + (process.env.PORT ? '' : ':' + PORT);
    getGarage(req.params.garage_id, url).then((garage) => {
        // the requested garage does not exist
        if (!garage) {
            return res.status(404).json({ Error: "No garage with this garage_id exists" });
        }
        // the requested garage exists
        else {
            return res.status(200).json(garage);
        }
    });
});

// update garage by id
router.patch("/garages/:garage_id", function (req, res) {
    if (!req.accepts(acceptType)) {
        return res.status(406).json({ Error: `Unsupported Accept MIME type ${req.accepts()}. Must accept ${acceptType}` });
    }
    // ensure included attributes are valid
    let validAttributes = true;
    for (key of Object.keys(req.body)) {
        if (!(key === 'name' || key === 'city' || key === 'state')) {
            validAttributes = false;
            break;
        }
    }
    if (validAttributes) {
        const url = req.protocol + '://' + req.hostname + (process.env.PORT ? '' : ':' + PORT);
        updateGarage(req.params.garage_id, req.body.name, req.body.city, req.body.state, url).then((garage) => {
            // the requested garage does not exist
            if (!garage) {
                return res.status(404).json({ Error: "No garage with this garage_id exists" });
            }
            // the requested garage exists
            else {
                return res.status(200).json(garage);
            }
        });
    } else {
        return res.status(400).json({ Error: "Only name, city, and/or state can be updated for a garage" });
    }
});

// delete garage by id
router.delete("/garages/:garage_id", function (req, res) {
    deleteGarage(req.params.garage_id).then((status) => {
        switch (status) {
            case 204:
                return res.status(204).send();
            case 400:
                return res.status(400).json({ Error: "Cannot delete a garage that contains cars" })
            case 404:
                return res.status(404).json({ Error: "No garage with this garage_id exists" });
        }
    });
});

// handle delete request to /garages
router.delete("/garages", function (req, res) {
    const url = req.protocol + '://' + req.hostname + (process.env.PORT ? '' : ':' + PORT) + req.originalUrl;
    res.set('Accept', 'GET, POST');
    return res.status(405).json({ Error: `The ${req.method} method is not allowed on ${url}` });
});

// put car in garage
router.put("/cars/:car_id/garages/:garage_id", function (req, res) {
    // check for authorization in header of request
    let requestAuth = req.headers.authorization;
    if (requestAuth === undefined) {
        // if no auth, return 401
        return res.status(401).send();
    } else {
        requestAuth = requestAuth.split(" ")[1];
    }
    verify(requestAuth).then((authorization) => {
        if (authorization) {
            addCarToGarage(authorization.sub, req.params.car_id, req.params.garage_id).then((status) => {
                switch (status) {
                    case 204:
                        return res.status(204).send();
                    case 400:
                        return res.status(400).json({ Error: "This car is already in a garage" });
                    case 403:
                        return res.status(403).json({ Error: "This car does not belong to the authenticated user" });
                    case 404:
                        return res.status(404).json({ Error: "Either no car with this car_id or garage with this garage_id exists" });
                }
            });
        } else {
            // provided auth id was not verified
            return res.status(401).send();
        }
    })
});

// remove car from garage
router.delete("/cars/:car_id/garages/:garage_id", function (req, res) {
    // check for authorization in header of request
    let requestAuth = req.headers.authorization;
    if (requestAuth === undefined) {
        // if no auth, return 401
        return res.status(401).send();
    } else {
        requestAuth = requestAuth.split(" ")[1];
    }
    verify(requestAuth).then((authorization) => {
        if (authorization) {
            removeCarFromGarage(authorization.sub, req.params.car_id, req.params.garage_id).then((status) => {
                switch (status) {
                    case 204:
                        return res.status(204).send();
                    case 400:
                        return res.status(400).json({ Error: "This car is not in this garage" });
                    case 403:
                        return res.status(403).json({ Error: "This car does not belong to the authenticated user" });
                    case 404:
                        return res.status(404).json({ Error: "Either no car with this car_id or garage with this garage_id exists" });
                }
            });
        } else {
            // provided auth id was not verified
            return res.status(401).send();
        }
    })
});
