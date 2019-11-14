var path = require('path');

// this is awkward but if we don't do it this way the schema load gets it's own copy of zgraphql and bad things happen
var graphqlNodeModulesDir = path.resolve(process.cwd(), 'graphql/node_modules');
var zgraphql = require(path.resolve(graphqlNodeModulesDir, 'zgraphql'));
require(path.resolve(graphqlNodeModulesDir, 'babel-register'));

function schemaProvider(callback) {
  var schemaDir = path.resolve(process.cwd(), '../graphql/schema/schema');
  var localSchema = require(schemaDir);
  callback(localSchema.schemas, localSchema.resolvers, localSchema.queries);
};

function startGraphqlServer() {
  zgraphql.start(schemaProvider, { devMode: true });
}

exports.startGraphqlServer = startGraphqlServer;
