/**
 * zodValidate.middleware.js — validates a request against a Zod schema at the
 * boundary. `source` selects what to validate: 'body' (default) -> req.validated,
 * or 'query' -> req.validatedQuery. On success it puts the clean, typed,
 * unknown-key-stripped data there (controllers read that, never the raw input). On
 * failure it stops the request with a 400 in our standard envelope — mirroring how
 * the existing express-validator `validate` middleware already reports input errors.
 */
function zodValidate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (result.success) {
      // Express 5's req.query is a read-only getter — never reassign it. Parsed
      // query goes on req.validatedQuery; body stays on req.validated.
      if (source === 'query') req.validatedQuery = result.data;
      else req.validated = result.data;
      return next();
    }
    const errors = result.error.issues.map((issue) => ({
      field: issue.path.join('.') || `(${source})`,
      message: issue.message,
    }));
    return res.status(400).json({
      success: false,
      message: errors[0].message, // first issue = the banner message for the FE
      data: null,
      errors,
    });
  };
}

module.exports = zodValidate;
