import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

function sendSMS(phone, code) {
  const snsClient = new SNSClient({});

  const command = new PublishCommand({
    Message: `Your OTP for Flock is ${code}. Use this code to validate.`,
    PhoneNumber: phone,
  });

  return snsClient.send(command);
}

export const handler = async (event) => {
  let secretLoginCode;

  if (!event.request.session || !event.request.session.length) {
    // Generate a new secret login code and send it to the user
    secretLoginCode = Date.now().toString().slice(-6);

    try {
      await sendSMS(event.request.userAttributes.phone_number, secretLoginCode);
    } catch (e) {
      console.error(e);
    }
  } else {
    // re-use code generated in previous challenge
    const previousChallenge = event.request.session.slice(-1)[0];
    secretLoginCode =
      previousChallenge.challengeMetadata.match(/CODE-(\d*)/)[1];
  }

  console.log(event.request.userAttributes);

  // Add the secret login code to the private challenge parameters
  // so it can be verified by the "Verify Auth Challenge Response" trigger
  event.response.privateChallengeParameters = { secretLoginCode };

  // Add the secret login code to the session so it is available
  // in a next invocation of the "Create Auth Challenge" trigger
  event.response.challengeMetadata = `CODE-${secretLoginCode}`;

  return event;
};
