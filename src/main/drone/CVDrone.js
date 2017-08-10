/**
 * @Author Tobias Schaber, codecentric AG
 *
 * Drone implementation
 */
"use strict";
/** set test mode to true to prevent the drone from really starting */

const Bebop = require("node-bebop");
const ping = require("net-ping");
const events = require('events');
const WebSocketServer = require('ws').Server;
const WatchJS = require("melanke-watchjs");
const watch = WatchJS.watch;
const filepath = require('filepath');
const fork = require('child_process').fork;
const fs = require('fs');
const readline = require('readline');
const eventEmitter = new events.EventEmitter();
const globalDebugLevel = 1;


readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
}
//module.exports = Drone;
//export default Drone;
/**
 * create a drone object. the constructor will set up all required sensors and components
 * @param flightDurationSec the duration in seconds the flight will last until landing
 * @param testMode if true, the drone will be in test mode and not start the drone
 * @constructor
 */

module.exports = class Drone {
    // TODO what are the default parameters for the constructor? if parameters are mandatory there must be a argument validation
    constructor(flightDurationSec, testMode) {
        this.log("setting up cv-drone...");

        this.bebopOpts = {};
        this.state = {};
        this.config = {};
        this.eventEmitter = eventEmitter;
        /** public configuration ================================================================================= */

        /* IP address of the drone.
         WLAN: 192.168.42.1, USB is 192.168.43.1 */
        this.bebopOpts.ip = '192.168.42.1';

        /* minimal battery level before landing */
        this.config.minBatteryLevel = 5;

        /* refresh interval of the distance sensors */
        this.config.sensorRefreshIntervall = 20;

        /* refresh interval of the flight control mechanism */
        this.config.flightControlInterval = 100;

        /* hotWord file for voice commands */
        this.config.hotWordFile = "voice/resources/snowboy.umdl";


        /** internal configuration =============================================================================== */

        /* internel event emitter for sending messages to the websocket */

        /* internal interval-id of the flight loop */
        this.flightControlId = -1;

        /* internal timeout-id of remaining time landing */
        this.timeOverId = -1;

        /* internal timeout id of triggering the flight control */
        this.triggerFlightControlId = -1;

        this.config.testMode = testMode;

        if (flightDurationSec > 0) {
            this.config.flightDurationSec = flightDurationSec;
        } else {
            throw new Error(`invalid flight duration. Your Input ${flightDurationSec} is <= 0`)
        }

        this.state.batteryLevel = 0;


        /** flying states ======================================================================================== */

        /* drone movement and speeds */
        this.speed = {};
        this.speed.forward = 0;            // current forward speed of the drone
        this.speed.turning = 0;            // current turning speed of the drone ( > 0 = clockwise)
        this.speed.turningDirection = 0;    // -1 =
        this.speed.strafing = 0;            // current strafing speed of the drone ( > 0 = right direction)
        this.speed.maxForward = 10;         // maximum forward speed
        this.speed.maxTurning = 40;         // turning speed if turning is active
        this.speed.maxStrafing = 0;         // maximum strafing speed
        this.speed.accVectorForward = 3;    // difference of speed when performing one acceleration step forwards
        this.speed.accVectorBackward = 5;   // difference of speed when breaking the drone one step
        this.speed.accVectorStrafing = 0;   // difference of speed when accelerating into strafing direction
        this.state.movementLocked = false;        // checks if further movement orders are accepted

        /* is the drone ready for takeoff?
         setting to "false" in the constructor will prevent the drone from starting up */
        this.state.readyForTakeoff = undefined;   // setting to false in constructor will prevent from
        this.state.isFlying = false;              // is the drone currently flying?
        this.state.isWLANConnected = true;       // is the pi connected to WLAN of the drone?
        this.state.isDroneConnected = false;      // is the connection to the drone stable?
        this.state.isReconnecting = false;        // is the drone currently reconnecting?
        this.state.sensorInitialized = true;     // are the sensors initialized ?

        this.state.autoPilot = true;              // is the drone in autopilot mode or manual controlled

        // TODO maybe not necessary
        this.state.distFront = 999;
        this.state.distLeft = 999;
        this.state.distRight = 999;


        if (this.config.testMode === true) {
            this.log("==================== T E S T M O D E =============");
        }

        /* register some handlers for global errors */
        process.on('exit', () => {
            this.onExit("exit");
        });
        process.on('SIGINT', () => {
            this.onExit("SIGINT");
        });    // CTRL+C
        process.on('SIGTERM', () => {
            this.onExit("SIGTERM")
        });  // KILL
        process.on('uncaughtException', (err) => {
            this.onException(err)
        });   // UNCAUGHT EXCEPTIONS
        process.stdin.on('keypress', (chunk, key) => {
            this.initKeyHandler(chunk, key)
        });


    }


    /**
     * trigger the drone after initiation
     */
    run() {
        try {
            // Add the Websocket server which sent data to the web-frontend
            this.addWebsocketServer();

            // add a http server for the webui

            try {
                this.log("starting http server");
                this.addHttpServer();
            } catch (err) {
                this.log(err)
            }


            /* recurring ping for live connection check */
            // TODO Maybe move to the top, because it is an attribute
            this.createPingSession()

            this.addEventListeners();
            // XXX
            eventEmitter.emit('sensorInitialized');
            this.connectDrone();


        } catch (error) {
            this.state.readyForTakeoff = false;
            this.log("error setting up drone: " + error);
            this.log(error);
            this.onException();
        }

        if (this.config.testMode === true) {
            eventEmitter.emit('initSensor');
        } else {
            eventEmitter.emit('ping');
        }
    }

    /**
     * creat a session for Pinging
     */

    createPingSession() {
        this.pingSession = ping.createSession({
            networkProtocol: ping.NetworkProtocol.IPv4,
            packetSize: 16,
            retries: 1,
            timeout: 500,
            ttl: 128
        });

    }

    /**
     * add all needed event listeners
     */
    addEventListeners() {
        // ping the drone if the ping event is emitted
        eventEmitter.on('ping', () => {
            this.pingDrone(this.bebopOpts.ip, (err) => this.reactOnPing(err))
        });

        // checks if the drone is in ready mode
        eventEmitter.on('triggerCheckReady', () => {
            this.checkReady();
        });

        // once the ping was successful, try to connect to the drone
        eventEmitter.once('pingSuccessful', () => {
            this.connectDrone();
        });

        // print a message that the drone-initiation is finished
        eventEmitter.once('initFinished', () => {
            this.log("setting up cv-drone finished! ready for takeoff.");
            this.log("====================================================");
            this.log("Press [T]akeoff, or [Return] for emergency landing!");
            this.log("====================================================");
        });
    }

    /**
     * check if the ready state is reached. If not it is triggered again after a certain time.
     * Once ready state is reached the method will not invoke anymore
     * @param delay set the timespan in milliseconds till the next triggerevent is fired
     */
    checkReady(delay = 1000) {
        let s = this.state;
        this.log('checking ready state');
        if (s.isWLANConnected && s.isDroneConnected && s.sensorInitialized) {
            eventEmitter.emit('initFinished');
        } else {
            setTimeout(() => eventEmitter.emit('triggerCheckReady'), delay);

            console.log(`not ready yet: WLAN: ${s.isWLANConnected}, Drone: ${s.isDroneConnected}, Sensor: ${s.sensorInitialized}`);
        }
    }

    /**
     * adds a websocket server so data can be sent to the webui. It reacts on events and forward them via the websocket connection
     */
    addWebsocketServer() {

        this.wss = new WebSocketServer({host: '0.0.0.0', port: 8000});

        // TODO What happens if multiple clients connect?
        this.wss.on('connection', (ws) => {
            this.log("websocket server ready");


            /*  this is the interface for controlling the drone via websocket.
             *   a message must be in json and the following structure:
             *   {
             *       'function': 'nameOfTheFunction',
             *       'args':     ['arg1', 'arg2', ... 'arg n']
             *    }
             *
             *    The method call is not automatically executed.
             *    Only the defined functions below can be called.
             */
            ws.on('message', (message) => {
                try {
                    let msg = JSON.parse(message);
                    if (msg.message) {
                        this.log('Message ' + msg.message)
                    } else if (msg.function) {
                        //console.log('recieved function call ' + msg.function)
                        try {
                            switch (msg.function) {
                                case 'turn':
                                    this.startRotate(msg.args[0]);
                                    break;
                                case 'autoPilot':
                                    this.setAutoPilot(msg.args[0]);
                                    break;
                                case 'takeOff':
                                    this.takeoff();
                                    break;
                                case 'land':
                                    this.landing('landing to python command');
                                    break;
                                default:
                                    this.log("unkown message: " + msg);
                                    break;
                            }
                        } catch (err) {
                            console.log(err.message)
                        }
                    }
                    //console.log(JSON.stringify(msg))
                } catch (error) {
                    console.log('Error message not in JSON Syntax')
                }
            });
        });

    }

    /**
     * Add a static http server which sent messages to the client
     */
    addHttpServer() {
        // fork a new process for the http server
        this.log("adding httpServer")
        this.httpServer = fork(filepath.create(__dirname, '/http/httpServer.js'));
    }

    /**
     * tries to connect to the drone
     */
    connectDrone() {
        /* ping drone once to check if connected */
        this.log("connecting to drone");

        this.bebop = Bebop.createClient(this.bebopOpts);
        /* connect to drone and pass a connected handler */
        this.bebop.connect(() => {
            this.onConnect()
        });

    }

    /**
     * this method is called when the connection to the drone is established.
     * we can then add some state listeners.
     */
    onConnect() {
        this.log("================================ CONNECTED TO DRONE");

        try {
            this.log("connected to drone")
            /* enables video streaming */
            // this.bebop.MediaStreaming.videoStreamMode(2);
            this.bebop.PictureSettings.videoStabilizationMode(3);
            this.bebop.MediaStreaming.videoEnable(1);

            //this.bebop.PilotingSettings.maxAltitude(2);
            //this.bebop.PilotingSettings.minAltitude(2);
            /* battery level check */
            this.bebop.on("battery", (data) => {
                this.batteryCheck(data)
            });
            this.bebop.on("ready", () => {
                this.onDroneReady();
            });


            // TODO ONLY FOR TESTING. REMOVE!
            this.bebop.on("hovering", function () {
                //console.log("hovering");
            });

            // TODO ONLY FOR TESTING. REMOVE!
            this.bebop.on("flying", function () {
                //console.log("flying");
            });

            if (this.config.testMode === false) {
                /* perform landing for emergencies */
                this.bebop.land(() => {
                    this.cleanUpAfterLanding()
                });

            }

            if (this.state.isReconnecting === true) {
                this.log("RECONNECTED!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
                this.state.isReconnecting = false;
            }
            this.checkReady();
        } catch (exception) {
            this.log(exception);
        }
    }

    /**
     * will clean up all handlers etc. after landing
     */
    cleanUpAfterLanding() {
        this.log("cleaning up after landing");

        /* stop the flight control loop */
        clearInterval(this.flightControlId);
        clearTimeout(this.timeOverId);
        clearTimeout(this.triggerFlightControlId);
    }


    /**
     * init some keyboard handlers for special keys like emergency controlling
     */
    initKeyHandler(ch, key) {

        console.log('key pressed');
        if (key.ctrl && key.name === 'c') {
            console.log("EXIT EVENT");
            this.onExit("STRG+C");
        } else {
            switch (key.name) {
                case 'return':
                    this.log("ENTER");
                    this.emergencyLand();
                    break;

                case 't':
                    this.buttonPushed(() => this.takeoff());

                    break;

                case 'left':
                    this.log("LEFT");
                    break;
                case 'right':
                    this.log("RIGHT");
                    break;

                default:
            }
        }
    }

    /**
     * logs a message and sends it to different listeners like console or web UI
     * @param message the message to log
     * @param key (optional). if not provided, "log" will be assumed
     * @param value (optional). useful for the WebHUD if not provided, "null" will be assumed
     * @param debugLevel (optional). Control how much infos are displayed in the LOG. 0 shows all messages. An increasing Number shows less messages.
     *
     */
    log(message, key, value, debugLevel) {

        /* assume "log" as key if not provided */
        key = key || "log";
        /* assume "NULL" as value if not provided */
        value = value || null;
        /* assume "1" as debugLevel if not provided */
        value = value || 1;

        /* assume global Loglevel if not set */
        debugLevel = debugLevel || globalDebugLevel;
        let returnMessage = {'key': key, 'message': message, 'value': value, 'debugLevel': debugLevel};

        /* log "log" keys to stdout */
        //if(key == "log") {
        console.log(returnMessage.message);
        //}

    }

    /**
     * setup method which checks that the drone is reachable via the network.
     * @param ip host address which is pinged
     * @param callback the function which is invoked auf ping
     */
    pingDrone(ip, callback) {
        let session;
        this.log("pinging drone")
        if (this.pingSession !== undefined) {
            session = this.pingSession
        } else {
            session = this.createPingSession();
            this.pingSession = session
        }
        session.pingHost(ip, (error) => {
            callback(error)
        })
    }

    /**
     * reaction on a ping. the reaction depends on whether the ping failed or not.
     * if it failed and the drone is in flying state, it will beep and blink to warn
     * all people around.
     * @param error
     */
    reactOnPing(error) {

        if (error) {
            console.log(error);

            this.state.isWLANConnected = false;
            this.log('wlan not connected');
            this.state.isDroneConnected = false;
            this.log('drone not connected');
            this.state.readyForTakeoff = false;
            this.log('Not ready for Takeoff');

            if (this.state.isFlying === true) {
                this.log('WARNING Ping failed but Object is in flying Mode', 'connectionLost', true);
                /* warn blinking */
            } else {
                this.log("drone not reachable: ping failed.");
            }
            setTimeout(() => {
                eventEmitter.emit('ping');

            }, 5000);
        } else {
            this.state.isWLANConnected = true;
            eventEmitter.emit('pingSuccessful');
            console.log('ping successful');

        }


    }

    /**
     * function will be executed as soon as there is the [ready] event arriving from the drone.
     */
    onDroneReady() {

        this.state.isDroneConnected = true;
        this.log("received [\"ready\"] event from drone.", 'isDroneConnected', this.state.isDroneConnected);

        /* if readyForTakeoff was set (from undef) to false while initialising, something is wrong,
         so do not set it to ready! */
        if (this.state.readyForTakeoff !== false) {
            this.state.readyForTakeoff = true;
            this.log('Ready for Takeoff set', 'readyForTakeoff', this.state.readyForTakeoff);
            eventEmitter.emit('triggerCheckReady');
        } else {
            this.log('Something ist wrong with the Takeoff state. It is: ' + this.state.readyForTakeoff, 'readyForTakeoff', this.state.readyForTakeoff);
            eventEmitter.emit('errorOnDroneReady');

        }

    }

    /**
     * react on a battery event and perform a check if the battery level is OK.
     * otherwise, make the drone not ready-for-takeoff and land the drone.
     * @param batteryLevel
     */
    batteryCheck(batteryLevel) {
        this.state.batteryLevel = batteryLevel;
        this.log("\rbattery level: " + batteryLevel + "%", 'batteryLevel', this.state.batteryLevel);

        if (batteryLevel < this.config.minBatteryLevel) {
            this.state.readyForTakeoff = false;
            this.log('readyForTakeoff changed to false due to battery low', 'readyForTakeoff', this.state.readyForTakeoff, 0);
            this.landing("battery low");
        }
    }


    /**
     * this method will let the drone takeoff
     */
    takeoff() {
        this.triggerFlightControlId = setTimeout(() => {
            this.triggerFlightControl()
        }, 5000);


        /* automatically land the drone after some time */
        this.timeOverId = setTimeout(() => {
            this.landing("flight time over")
        }, (this.config.flightDurationSec * 1000));


        if (this.config.testMode === false) {
            this.bebop.takeOff();
            this.log("============= TAKING OFF!!! Flight length will be : " + this.config.flightDurationSec + " sec.", 'takeOff', this.config.flightDurationSec);
        } else {
            this.log("[[drone is in test mode so will not take off]]", 'takeOff', 0);
        }
    }


    triggerFlightControl() {
        /* start the flight control loop */
        this.flightControlId = setInterval(() => {
            this.flightControl()
        }, this.config.flightControlInterval);
    }

    /**
     * this method will let the drone land
     */
    landing(message) {

        this.log("received landing event: " + message, ' landing');

        if (this.state.isFlying === true) {


            this.log("============= LANDING NOW!!!");

            if (this.config.testMode === false) {
                this.bebop.stop();
                this.bebop.land(this.cleanUpAfterLanding());
            } else {
                this.log("[[drone is in test mode so will not land}}", 'landing');
                this.cleanUpAfterLanding();
            }

            this.state.isFlying = false;
            this.log('changed flying state to: ' + this.state.isFlying, 'isFlying', this.state.isFlying, 0);
        } else {
            this.log("the drone is not in [flying] state. will nevertheless land.", 'landing');
            try {
                this.bebop.stop();
            } catch (error) {
                this.log('not connected to drone, cant stop')
            }
            this.bebop.land(this.cleanUpAfterLanding());
        }
    }


    /**
     * ===========================================================================================================
     * central steering of the drone
     * ===========================================================================================================
     *
     * this is the central steering logic of the drone.
     * it will be called in a configurable interval (this.config.flightControlInterval).
     */
    flightControl() {

        if (this.state.isDroneConnected === true) {
            let distFront = this.state.distFront;
            let distLeft = this.state.distLeft;
            let distRight = this.state.distRight;
            let tooClose = false

            if (distFront < 80 || distLeft < 70 || distRight < 70) {
                this.landing("came to close to anything (F: " + distFront + " R: " + distRight + " L: " + distLeft);
                tooClose = true
            }

            const stopDistance = 120;

            //TODO add "rotatingPuffer" um nach einem Stop länger nachzudrehen?
            if (this.state.autoPilot === true && tooClose === false) {
                /* one of the distances is lower then stop-distance, slow down the drone and start rotating */
                if (distFront < stopDistance || distLeft < stopDistance || distRight < stopDistance) {
                    this.slowDown();

                    if ((distLeft <= stopDistance) || distFront <= stopDistance) {
                        //setTimeout(this.startRotate(1), 100);
                        this.startRotate(1);
                    }

                    if (distRight <= stopDistance && distLeft >= stopDistance) {
                        //setTimeout(this.startRotate(-1), 100);
                        this.startRotate(-1);
                    }

                } else {

                    /* upfront free */
                    this.stopRotate();
                    //setTimeout(this.accelerate(), 500);
                    this.accelerate();
                }
            }


        } else {

            if (this.state.isWLANConnected === false) {
                this.log("WLAN NOT CONNECTED");
            } else {

                /* WLAN connected but drone disconnected */
                if (this.state.isDroneConnected === false) {

                    /* execute only once per reconnection try */
                    if (this.state.isReconnecting === false) {
                        this.state.isReconnecting = true;

                        try {
                            //TODO: TRY TO REMOVE OLD CALLBACK

                            this.log("Adding a new connection listener and waiting for connection.");

                            /* add a new connect handler as the old seems no longer working */
                            this.bebop.connect(this.onConnect());
                        } catch (error) {
                            this.log(error);
                        }
                    }
                }
            }
        }
    }


    /**
     * Lock the drone so no further movement commands will be executed
     * @param duration time in ms for the lock
     */
    lockMovement(duration) {
        this.log("locking movement")
        this.state.movementLocked = true;
        setTimeout(() => this.unlockMovement(), duration);
    }

    /**
     * unlock the Drone so it can move again
     */
    unlockMovement() {
        this.state.movementLocked = false;
    }

    /**
     * set the autopilot mode
     */

    setAutoPilot(boolean) {
        if (boolean === 'true' || boolean === true) {
            this.state.autoPilot = true;
            this.log(`autoPilot changed because value valid. Value: ${boolean}`)

        } else if (boolean === 'false' || boolean === false) {
            this.state.autoPilot = false;
            this.stopRotate();
            this.slowDown()
            this.log(`autoPilot changed because value valid. Value: ${boolean}`)


        } else {
            this.log(`autoPilot not changed because value is invalid. Value: ${boolean}`)
        }
    }

    /**
     * stop the drone rotating if it is currently turning
     */
    stopRotate() {

        if (this.speed.turning !== 0 && !this.state.movementLocked) {
            if (this.config.testMode !== true) {
                this.bebop.clockwise(0);
                this.bebop.stop();
            }
            this.speed.turning = 0;
            //this.log('turning speed set to: ' + this.speed.turning, 'speedChanged', this.speed, 0)
        }
    }



    /**
     * start the drone rotation if not yet turning
     * @param direction 1 = clockwise, -1 = counterclockwise
     */
    startRotate(direction) {
        console.log('rotate ' + direction)
        this.speed.turningDirection = direction;
        //this.log('Turning Direction changed: ' + direction, 'turningDirection', direction, 0);
        if (this.speed.turning !== 0) {
            this.stopRotate()
        }
        if (this.speed.turning === 0 && !this.state.movementLocked) {
            if (this.config.testMode !== true) {
                this.bebop.stop();
            }
            this.speed.turning = this.speed.maxTurning;
            //this.log('turning speed set to: ' + this.speed.turning, 'turningSpeed', this.speed.turning, 0)
            if (this.config.testMode !== true) {
                if (direction === 1) {
                    this.bebop.clockwise(this.speed.turning);
                } else if (direction === 1) {
                    this.bebop.counterClockwise(this.speed.turning);
                } else {
                    this.stopRotate()
                }
            }
        } else {
            console.log('Locked ' + this.state.movementLocked)
            console.log('TurningSpeed ' + this.speed.turning)
        }
    }


    /**
     * accelerate the drone up to a configured maximum speed
     */
    accelerate() {

        if (this.speed.forward < this.speed.maxForward && !this.state.movementLocked) {
            if (this.config.testMode !== true) {
                this.bebop.stop();
            }
            this.speed.forward = this.speed.maxForward;
            //this.log('forward speed set to: ' + this.speed.forward, 'forwardSpeed', this.speed.forward, 0)
            this.bebop.forward(this.speed.forward);
        }
    }


    /**
     * break the drone
     */
    slowDown() {

        if (this.speed.forward !== 0 && !this.state.movementLocked) {
            this.lockMovement(1000);
            this.speed.forward = 0;
            //this.log('forward speed set to: ' + this.speed.turning, 'forwardSpeed', this.speed.forward, 0)
            if (this.config.testMode !== true) {
                this.bebop.stop();
            }

        }
    }


    /**
     * exception handler. will be called on every urgent exception.
     * will stop the drone with warnings end then exit.
     */
    onException(err) {

        this.log(err);
        this.killForks()

        this.emergencyLand();
    }


    /**
     * react on any exiting event like STRG+C or KILL
     */
    onExit() {

        this.log("Received EXIT command");

        if (this.state.isFlying === true) {
            this.landing("landing on exit event");
        }
        this.killForks()

        process.exit(1);

    }

    /**
     * kills all forked process
     */
    killForks() {
        try {
            this.httpServer.kill();
        } catch (err) {
            this.log('Error while killing the forked process: ' + err)
        }
    }

    /**
     * perform an emergency landing of the drone at the place where it is standing
     *
     */
    emergencyLand() {

        this.log("============= EMERGENCY LANDING NOW!");
        // stop drone etc.
        if (this.config.testMode !== true) {
            this.bebop.stop();
            this.bebop.land(this.cleanUpAfterLanding());
        }
        this.state.isFlying = false;

        if (this.config.testMode === true) {
            this.cleanUpAfterLanding();
        }

    }
}


