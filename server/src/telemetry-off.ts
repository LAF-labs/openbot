/**
 * The CopilotKit runtime phones home unless told not to, and this fork's rule is that
 * the only things this process talks to are the model API and our own machines. Set as
 * code, not documentation: an operator who forgets a variable must not become a data
 * point. First import of the entrypoint so it is in force before the runtime loads.
 */
process.env.COPILOTKIT_TELEMETRY_DISABLED ??= "true";
