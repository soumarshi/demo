export const handler = async (event: any) => {
  console.log('STAGE:', process.env.STAGE);
  console.log('Event:', JSON.stringify(event, null, 2));

  // Your cron logic goes here
  // e.g., call an API, run cleanup, enqueue SQS, etc.

  return {
    ok: true,
    ranAt: new Date().toISOString()
  };
};
