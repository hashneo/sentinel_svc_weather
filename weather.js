'use strict';
require('array.prototype.find');

function _module(config) {

    if ( !(this instanceof _module) ){
        return new _module(config);
    }

    const redis = require('redis');
    var moment = require('moment');

    let pub = redis.createClient(
        {
            host: process.env.REDIS || global.config.redis || '127.0.0.1' ,
            socket_keepalive: true,
            retry_unfulfilled_commands: true
        }
    );

    pub.on('end', function(e){
        console.log('Redis hung up, committing suicide');
        process.exit(1);
    });

    const crypto = require('crypto');

    let NodeCache = require( "node-cache" );

    let deviceCache = new NodeCache();
    let statusCache = new NodeCache();

    let merge = require('deepmerge');

    let request = require('request');
    let https = require('https');
    let keepAliveAgent = new https.Agent({ keepAlive: true });


    /*
        require('request').debug = true
        require('request-debug')(request);
    */
    let apiKey = global.config.apiKey;

    if (!apiKey){
        console.error('Missing apiKey in configuration');
        process.exit(1);
    }

    let Wunderground = require('wunderground-api');
    let client = new Wunderground(apiKey);

    let opts = global.config.location;

    deviceCache.on( 'set', function( key, value ){
        let data = JSON.stringify( { module: global.moduleName, id : key, value : value });
        console.log( 'sentinel.device.insert => ' + data );
        pub.publish( 'sentinel.device.insert', data);
    });

    deviceCache.on( 'delete', function( key ){
        let data = JSON.stringify( { module: global.moduleName, id : key });
        console.log( 'sentinel.device.delete => ' + data );
        pub.publish( 'sentinel.device.delete', data);
    });

    statusCache.on( 'set', function( key, value ){
        let data = JSON.stringify( { module: global.moduleName, id : key, value : value });
        //console.log( 'sentinel.device.update => ' + data );
        pub.publish( 'sentinel.device.update', data);
    });

	let that = this;

    function hashId(v){
        let shasum = crypto.createHash('sha1');
        shasum.update(v);
        return shasum.digest('hex');
    }

    function processHumidity( d ){
        let device = { 'current' : {} };
        device['name'] = d.display_location.full + ' - Humidity';
        device['id'] = hashId( d.display_location.full + ',' +  d.display_location.latitude + ',' + d.display_location.longitude + ',humidity' );
        device['type'] = 'sensor.humidity';
        device['current'] = { 'armed' : 'false', 'tripped' : { 'current' : true, 'last' : new Date(d.observation_time_rfc822).toISOString() },  'humidity' : {} };
        device['current']['humidity']['current'] = parseInt(d.relative_humidity.replace('%',''));
        //device['current']['online'] = d.Online;
        return device;
    }

    function processWind( d ){
        let device = { 'current' : {} };
        device['name'] = d.display_location.full + ' - Wind';
        device['id'] = hashId( d.display_location.full + ',' + d.display_location.latitude + ',' + d.display_location.longitude + ',wind' );
        device['type'] = 'sensor.wind';
        device['current'] = { 'armed' : 'false', 'tripped' : { 'current' : true, 'last' : new Date(d.observation_time_rfc822).toISOString() },  'wind' : {} };
        device['current']['wind']['current'] = Math.round(( parseInt(d.wind_kph) / 1852) * 1000 );
        device['current']['wind']['gust'] = Math.round(( parseInt(d.wind_gust_kph) / 1852) * 1000 );
        device['current']['wind']['direction'] = parseInt(d.wind_degrees);
        //device['current']['online'] = d.Online;
        return device;
    }

    function processTemperature( d ){
        let device = { 'current' : {} };
        device['name'] = d.display_location.full + ' - Temperature';
        device['id'] = hashId( d.display_location.full + ',' + d.display_location.latitude + ',' + d.display_location.longitude + ',temperature' );
        device['type'] = 'sensor.temperature';
        device['current'] = { 'armed' : 'false', 'tripped' : { 'current' : true, 'last' : new Date(d.observation_time_rfc822).toISOString() },  'temperature' : {}, };
        device['current']['temperature']['current'] = d.temp_f;
        //device['current']['online'] = d.Online;
        return device;
    }

    this.getDevices = () => {

        return new Promise( (fulfill, reject) => {
            deviceCache.keys( ( err, ids ) => {
                if (err)
                    return reject(err);

                deviceCache.mget( ids, (err,values) =>{
                    if (err)
                        return reject(err);

                    statusCache.mget( ids, (err, statuses) => {
                        if (err)
                            return reject(err);

                        let data = [];

                        for (let key in values) {
                            let v = values[key];

                            if ( statuses[key] ) {
                                v.current = statuses[key];
                                data.push(v);
                            }
                        }

                        fulfill(data);
                    });

                });
            });
        });
    };

    this.getDeviceStatus = (id) => {

        return new Promise( (fulfill, reject) => {
            try {
                statusCache.get(id, (err, value) => {
                    if (err)
                        return reject(err);

                    fulfill(value);
                }, true);
            }catch(err){
                reject(err);
            }
        });

    };

    function updateStatus() {
        return new Promise( ( fulfill, reject ) => {

            client.conditions(opts, function(err, data) {
                if (err)
                    return reject(err);

                let t = processTemperature(data);
                statusCache.set(t.id, t.current);

                let w = processWind(data);
                statusCache.set(w.id, w.current);

                let h = processHumidity(data);
                statusCache.set(h.id, h.current);

            });

            fulfill();
        });
    }

    this.Reload = () => {
        return new Promise( (fulfill,reject) => {
            fulfill([]);
        });
    };

    function loadSystem(){
        return new Promise( ( fulfill, reject ) => {

            client.conditions(opts, function(err, data) {
                if (err)
                    return reject(err);

                let devices = [];

                let t = processTemperature(data);

                statusCache.set(t.id, t.current);
                delete t.current;
                deviceCache.set(t.id, t);
                devices.push(t);

                let w = processWind(data);

                statusCache.set(w.id, w.current);
                delete w.current;
                deviceCache.set(w.id, w);
                devices.push(w);

                let h = processHumidity(data);

                statusCache.set(h.id, h.current);
                delete h.current;
                deviceCache.set(h.id, h);
                devices.push(h);

                fulfill(devices);
            });
        });
    }

    loadSystem()

        .then( () => {

            function pollSystem() {
                updateStatus()
                    .then(() => {
                        setTimeout(pollSystem, 300000);
                    })
                    .catch((err) => {
                        console.error(err);
                        setTimeout(pollSystem, 60000);
                    });

            }

            setTimeout(pollSystem, 10000);

        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });

    return this;
}

module.exports = _module;