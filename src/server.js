const env = require("./config/env");
const app = require("./app");
const { connectDb, closeDb } = require("./db");
const { processLeaveSchedules } = require("./services/leave.service");
   
async function start() {
  await connectDb();
  await processLeaveSchedules();
  const leaveSchedule = setInterval(() => {
    processLeaveSchedules().catch((error) => {
      console.error("Could not process resolver leave schedules:", error);
    });
  }, 60_000);
  const server = app.listen(env.PORT, "0.0.0.0", () => {
    console.log(`Service Desk API running on http://0.0.0.0:${env.PORT}`);
  });

  const shutdown = () => {
    clearInterval(leaveSchedule);
    server.close(() => {
      void closeDb().then(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((error) => {
  console.error("Could not start the Service Desk API:", error);
  process.exit(1);
});
