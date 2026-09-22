/**
 * Centralized configuration for API Changelog Radar.
 */

export const CONFIG = {
  app: {
    name: 'API Changelog Radar',
    version: '1.0.0',
  },

  auth: {
    jwtExpirySeconds: 86400,       // 24 hours
    refreshExpirySeconds: 604800,  // 7 days
    maxLoginAttempts: 10,          // per 15 min window
  },

  polling: {
    defaultIntervalMinutes: 60,
    minIntervalMinutes: 5,
    maxIntervalMinutes: 1440,      // 24 hours
    fetchTimeoutMs: 15000,         // 15 seconds
    maxConsecutiveFailures: 5,
    userAgent: 'APIChangelogRadar/1.0 (https://github.com/Hardonian/api-changelog-radar)',
    maxContentBytes: 5_242_880,    // 5 MB
  },

  plans: {
    free:    { maxSources: 2,   retentionDays: 7,   rateRpm: 30,   features: { apiAccess: false, webhookAlerts: false, slackAlerts: false } },
    starter: { maxSources: 5,   retentionDays: 30,  rateRpm: 60,   features: { apiAccess: true,  webhookAlerts: true,  slackAlerts: false } },
    growth:  { maxSources: 25,  retentionDays: 90,  rateRpm: 300,  features: { apiAccess: true,  webhookAlerts: true,  slackAlerts: true } },
    scale:   { maxSources: 200, retentionDays: 365, rateRpm: 1000, features: { apiAccess: true,  webhookAlerts: true,  slackAlerts: true } },
  },

  rateLimiting: {
    windowSeconds: 60,
    unauthenticatedRpm: 20,
    leadCaptureRpm: 5,
  },

  cors: {
    // Update these with your actual domains
    allowedOrigins: [
      'https://api-changelog-radar-frontend.pages.dev',
      'https://api-changelog-radar-landing.pages.dev',
      'http://localhost:8788',                          // local wrangler dev
      'http://localhost:3000',                          // local dev
    ],
    maxAge: 86400,
  },

  diff: {
    breakingKeywords: ['removed', 'breaking', 'sunset', 'discontinued', 'deleted', 'incompatible'],
    warningKeywords: ['deprecated', 'changed', 'modified', 'renamed', 'migration required'],
  },

  alerts: {
    maxRetries: 3,
    retryBackoffMs: [1000, 5000, 30000],
  },

  pagination: {
    defaultLimit: 20,
    maxLimit: 100,
  },
};
