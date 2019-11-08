require('babel-register');

var zgraphql = require('zgraphql');
var path = require('path');

function schemaProvider(callback) {
  var schemaDir = path.resolve(process.cwd(), '../graphql/schema/schema');
  var localSchema = require(schemaDir);
  callback(localSchema.schemas, localSchema.resolvers, localSchema.queries);
};

function startGraphqlServer() {
  zgraphql.start(schemaProvider, { devMode: true });
}

exports.startGraphqlServer = startGraphqlServer;
