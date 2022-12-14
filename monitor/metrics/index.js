// websocket server that dashboard connects to.
const redis = require('redis');
const got = require('got');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Obtain the IP of the web-srv
let webIP = fs.readFileSync("./deployment/vars/proxy-ip.txt").toString();

// Obtain the IP of blue and green
let blueIp = null;
let greenIp = null;
let vmInfo = yaml.load(fs.readFileSync("./deployment/bakerx.yml", { encoding: 'utf-8' }));
for (let i = 0; i < vmInfo.servers.length; i++) {
	if (vmInfo.servers[i].name === "blue") {
		blueIp = vmInfo.servers[i].ip;
	} else if (vmInfo.servers[i].name === "green") {
		greenIp = vmInfo.servers[i].ip;
	}
}

// Obtain the port that the application is running on
let port = JSON.parse(
	fs.readFileSync("./deployment/vars/webapp-port.json")
);

// Obtain the endpoint for monitoring health
let endpoint = JSON.parse(
	fs.readFileSync("./deployment/vars/webapp-endpoint.json")
);

/// Servers data being monitored.
var servers = [
	{ name: "web-srv", url: `http://${webIP}:3090${endpoint}`, status: "#cccccc", scoreTrend : [0] },
	{ name: "blue", url: `http://${blueIp}:${port}${endpoint}`, status: "#cccccc", scoreTrend: [0] },
	{ name: "green", url: `http://${greenIp}:${port}${endpoint}`, status: "#cccccc", scoreTrend: [0] }
];

function start(app) {
	////////////////////////////////////////////////////////////////////////////////////////
	// DASHBOARD
	////////////////////////////////////////////////////////////////////////////////////////
	const io = require('socket.io')(3000);
	// Force websocket protocol, otherwise some browsers may try polling.
	io.set('transports', ['websocket']);
	// Whenever a new page/client opens a dashboard, we handle the request for the new socket.
	io.on('connection', function (socket) {
        // console.log(`Received connection id ${socket.id} connected ${socket.connected}`);

		if (socket.connected) {
			//// Broadcast heartbeat event over websockets ever 1 second
			var heartbeatTimer = setInterval( function () {
				socket.emit("heartbeat", servers);
			}, 1000);

			//// If a client disconnects, we will stop sending events for them.
			socket.on('disconnect', function (reason) {
				console.log(`closing connection ${reason}`);
				clearInterval(heartbeatTimer);
			});
		}
	});

	/////////////////////////////////////////////////////////////////////////////////////////
	// REDIS SUBSCRIPTION
	/////////////////////////////////////////////////////////////////////////////////////////
	let client = redis.createClient(6379, 'localhost', {});
	// We subscribe to all the data being published by the server's metric agent.
	for (var server of servers) {
		// The name of the server is the name of the channel to recent published events on redis.
		client.subscribe(server.name);
	}

	// When an agent has published information to a channel, we will receive notification here.
	client.on("message", function (channel, message) {
		console.log(`Received message from agent: ${channel}`);
		for (var server of servers) {
			// Update our current snapshot for a server's metrics.
			if (server.name == channel) {
				let payload = JSON.parse(message);
				server.memoryLoad = payload.memoryLoad;
				server.cpu = payload.cpu;
				updateHealth(server);
			}
		}
	});

	// LATENCY CHECK
	var latency = setInterval( function () {
		for (var server of servers)	{
			if (server.url) {
				let start = Date.now();

				// Bind a new variable in order to for it to be properly captured inside closure.
				let captureServer = server;

				// Make request to server we are monitoring.
				got(server.url, { timeout: 5000, throwHttpErrors: false }).then(function(res) {
					captureServer.statusCode = res.statusCode;
					captureServer.latency = Date.now() - start;

					// console.log(`asdfasdfasdf ${res.statusCode}`);
				}).catch( e => {
					// console.log(e);
					captureServer.statusCode = e.code;
					captureServer.latency = 5000;
				});
			}
		}
	}, 10000);
}

function updateHealth(server) {
	let score = 0;
	// Update score calculation.
	score += (1 * (server.memoryLoad / 100))
	score += (1 * (server.cpu / 100))
	score += (1000 - Math.min(server.latency, 1000)) / 1000
	score += server.statusCode === 200 ? 1 : -2;

	server.status = score2color(score / 4);

	console.log(`${server.name} ${score / 4}`);

	// Add score to trend data.
	server.scoreTrend.push((4 - score));
	if (server.scoreTrend.length > 15) {
		server.scoreTrend.shift();
	}
}

function score2color(score) {
	if (score <= 0.25) return "#ff0000";
	if (score <= 0.50) return "#ffcc00";
	if (score <= 0.75) return "#00cc00";
	return "#00ff00";
}

module.exports.start = start;