var http = require('http');
var redis = require('redis');
var domain = require('domain');
var util = require('util');
var EventEmitter = require('events').EventEmitter
var REDIS_CHANNEL_IN = 'testem-wrap-proxy-bridge-python-js';
var REDIS_CHANNEL_OUT = 'testem-wrap-proxy-bridge-js-python';

var _expectBody = function (req) {
  var contentType = req.headers['content-type'];
  // Buffer the body if needed
  return ((req.method == 'POST' || req.method == 'PUT') &&
    (contentType && (contentType.indexOf('form-urlencoded') > -1 ||
    contentType.indexOf('application/json') > -1)));
};

var Bridge = function (channelUuid) {
  var inClient = redis.createClient();
  var outClient = redis.createClient();

  inClient.on('error', console.error);
  outClient.on('error', console.error);

  this.channelIn = [REDIS_CHANNEL_IN, channelUuid].join('-');
  this.channelOut = [REDIS_CHANNEL_OUT, channelUuid].join('-');
  this.server = http.createServer();
  this.retries = 0;
  this.inClient = inClient;
  this.outClient = outClient;
  this.currReqId = 0;
  this.inFlight = {};
};

util.inherits(Bridge, EventEmitter);

Bridge.prototype.start = function () {
  var server = this.server;
  var client = this.inClient;

  server.addListener('request', this.acceptRequest.bind(this));
  server.addListener('error', this.handleServerError.bind(this));

  this.startServer();

  client.subscribe(this.channelIn);
  client.on('message', this.handleInMessage.bind(this));
};

Bridge.prototype.handleServerError = function (err) {
  if (err.code == 'EADDRINUSE') {
    this.retries++;
    if (this.retries > 6) {
      throw new Error('Could not bind the testem-wrap proxy server to the right port');
    }
    // Try restarting with exponential backoff -- 1, 2, 4, 8, 16, 32 seconds
    setTimeout(this.startServer.bind(this), Math.pow(2, this.retries) * 500);
  }
  else {
    throw new Error('Something went wrong starting the testem-wrap proxy server.');
  }
};

Bridge.prototype.startServer = function () {
  this.server.listen(9001, '127.0.0.1');
};

Bridge.prototype.acceptRequest = function (req, resp) {
  var self = this;
  var dmn = domain.create();
  var handle = this.handleRequest.bind(this);
  var body = '';

  dmn.on('error', function (err) {
    resp.writeHead(500, {'Content-Type': 'text/plain'});
    resp.write(err.message || 'Something went wrong');
    resp.end();
  });
  dmn.add(req);
  dmn.add(resp);

  dmn.run(function () {
    self.currReqId++;

    // Buffer the body if needed
    if (_expectBody(req)) {
      // FIXME: Assumes the entire request body is in the buffer,
      // not streaming request
      req.addListener('readable', function (data) {
        var chunk;
        while ((chunk = req.read())) {
          body += chunk;
        }
      });

      req.addListener('end', function () {
        req.body = body;
        handle(req, resp);
      });
    }
    else {
      handle(req, resp);
    }
  });
};

Bridge.prototype.handleRequest = function  (req, resp) {
  var id = this.currReqId;
  var req = {
    reqId: id,
    method: req.method,
    contentType: req.headers['content-type'],
    url: req.url,
    body: req.body || null,
    qs: req.url.split('?')[1] || null
  };
  var message = {
    type: 'req',
    data: req
  };
  this.inFlight['req' + id] = {
    req: req,
    resp: resp
  };

  this.outClient.publish(this.channelOut, JSON.stringify(message));
};

Bridge.prototype.handleInMessage = function (channel, messageJson) {
  var message = JSON.parse(messageJson);
  
  if (channel == this.channelIn) {
    if ( message.type === 'api-response' ) {
      var key = 'req' + message.data.reqId;
      var current = this.inFlight[key];
      delete this.inFlight[key];
      resp = current.resp;
      resp.writeHead(message.data.status_code, {'Content-Type': message.data.content_type});
      if (message.data.content.length) {
        resp.write(message.data.content);
      } else {
        resp.write('{}'); // default empty error content to get response object to parse properly
      }
      resp.end();
    } else if ( message.type === 'command') {
      if ( message.data.command === 'test-resume' ) {
        this.emit('test-resume');
      }
    }
  }
};

Bridge.prototype.stop = function () {
  this.server.close();
  this.inClient.end();
  this.outClient.end();
};

Bridge.prototype.sendCmd = function (message) {
  this.outClient.publish(this.channelOut, JSON.stringify({
    type: 'cmd',
    data: message
  }));
};

exports.Bridge = Bridge;
