module.exports = {
  root: true,
  env: {
    es6: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
    "google",
  ],
  parserOptions: {
    ecmaVersion: 2020, // or higher if needed, e.g., 2022 for top-level await
  },
  rules: {
    "quotes": ["error", "double"],
    "indent": ["error", 2],
    "object-curly-spacing": ["error", "always"],
    "require-jsdoc": "off", // Turn off JSDoc requirement for now
    "max-len": ["error", {"code": 120}], // Adjust max line length if needed
    "operator-linebreak": "off", // Allow operator linebreak flexibility
    "no-restricted-globals": ["error", "name", "length"],
    "prefer-promise-reject-errors": ["error"],
  },
};
