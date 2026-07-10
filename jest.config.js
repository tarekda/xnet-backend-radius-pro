/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  setupFiles: ['reflect-metadata'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  clearMocks: true,
};
