// Use a subpath only for the hosted web export; native and local builds keep their normal routes.
module.exports = ({ config }) => process.env.LINKUP_WEB_BASE_URL
  ? { ...config, experiments: { ...config.experiments, baseUrl: process.env.LINKUP_WEB_BASE_URL } }
  : config;
