const mode = process.argv[2] ?? "missing";
const allowedSecret = process.env.BROKER_TEST_SECRET ?? "<missing>";
const parentSecret = process.env.SANDBOX_BROKER_PARENT_SECRET ?? "<missing>";

process.stdout.write(`mode=${mode}\n`);
process.stdout.write(`allowed=${allowedSecret}\n`);
process.stdout.write(`parent=${parentSecret}\n`);
process.stderr.write(`stderr=${allowedSecret}\n`);
