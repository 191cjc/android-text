const { startLocalServer } = require("../src/local-server");

startLocalServer()
  .then((server) => {
    console.log(`Local server running at ${server.url}`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
