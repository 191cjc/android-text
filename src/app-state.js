const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const state = {
  projectRoot,
  mode: process.env.APP_MODE || "local",
  remotePageUrl: "https://www.4399.com/flash/115225_2.htm",
  sourceBaseUrl:
    "https://sbai.4399.com/4399swf/upload_swf/ftp10/honghao/20130530/27/",
  remoteSwfFileName: "xfbbv451.swf",
  swfFileName: "xfbbv451.swf",
  externalProxyPolicies: [
    { host: "stat.api.4399.com", allowOverride: false },
    { host: "cdn.comment.4399pk.com", allowOverride: true },
    { host: "media.5054399.net", allowOverride: false },
    {
      host: "save.api.4399.com",
      allowOverride: false,
      query: { ac: "get_time" },
    },
  ],
  activeMod: "vanilla",
  requestLog: [],
};

function logRequest(entry) {
  state.requestLog.unshift({
    time: new Date().toISOString(),
    ...entry,
  });

  if (state.requestLog.length > 250) {
    state.requestLog.length = 250;
  }
}

module.exports = {
  state,
  logRequest,
};
