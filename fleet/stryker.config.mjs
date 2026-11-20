export default {
  mutate: ['src/domain.js'],
  testRunner: 'command',
  commandRunner: {
    command: 'node --test test/domain.test.js test/geofence-property.test.js',
  },
  coverageAnalysis: 'off',
  reporters: ['clear-text', 'json'],
  thresholds: { high: 85, low: 75, break: 70 },
  concurrency: 4,
};
