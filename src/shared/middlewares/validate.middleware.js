/**
 * validate.middleware.js — turns express-validator results into a clean 400.
 *
 * WHY: the validation RULES (isEmail, isLength, ...) are declared on each route.
 * This middleware is the shared step that RUNS after those rules and, if any
 * failed, stops the request before it ever reaches the controller/DB. Keeping it
 * in one place means every route reports input errors the exact same way.
 */
const { validationResult } = require('express-validator');

function validate(req, res, next) {
  const errors = validationResult(req);

  // No problems → carry on to the controller.
  if (errors.isEmpty()) {
    return next();
  }

  // Problems → respond 400 immediately. We surface the FIRST message as the
  // top-level `message` (that's the string the frontend shows in its error
  // banner), and include the full list under `errors` for debugging.
  const list = errors.array();
  return res.status(400).json({
    success: false,
    message: list[0].msg,
    errors: list.map((e) => ({ field: e.path, message: e.msg })),
  });
}

module.exports = validate;
