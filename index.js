'use strict';

const bodyParser = require('body-parser');
const crypto = require('crypto');
const express = require('express');
const fetch = require('node-fetch');
const request = require('request');
const normalizeString = require('./normalize-string');

let Wit = null;
let log = null;
try {
  // if running from repo
  Wit = require('../').Wit;
  log = require('../').log;
} catch (e) {
  Wit = require('node-wit').Wit;
  log = require('node-wit').log;
}

// Webserver parameter
const PORT = process.env.PORT || 8445;

// Wit.ai parameters
const WIT_TOKEN = "KQRXJQ4AYWC2U3V3JK4GGR2CRBGKLLIR";

// Messenger API parameters
const FB_PAGE_TOKEN = "EAATOwRMaZCVgBAIAXFgw7SZCZA8gYETKPhw6RJFEZAsEvpZBBZAoiJr3knx4Ryf7DpvaP2zzyc8kLPybcC8CHZB6M2tRET3w3Ezjj5BdK6gPzh34N92b6yZBhaXy1Lectlo51ieXlp12zRwW6h3Tfoik3yW6EPxVoPNBzAqHVAyWzAZDZD";
if (!FB_PAGE_TOKEN) { throw new Error('missing FB_PAGE_TOKEN') }
const FB_APP_SECRET = "fecaee66d79c7053dd2fca727489f94b";
if (!FB_APP_SECRET) { throw new Error('missing FB_APP_SECRET') }

let FB_VERIFY_TOKEN = "my_voice_is_my_password_verify_me";
crypto.randomBytes(8, (err, buff) => {
  if (err) throw err;
  FB_VERIFY_TOKEN = buff.toString('hex');
  console.log(`/webhook will accept the Verify Token "${FB_VERIFY_TOKEN}"`);
});

// ----------------------------------------------------------------------------
// Messenger API specific code

// See the Send API reference
// https://developers.facebook.com/docs/messenger-platform/send-api-reference

const fbMessage = (id, text) => {
  const body = JSON.stringify({
    recipient: { id },
    message: { text },
  });
  const qs = 'access_token=' + encodeURIComponent(FB_PAGE_TOKEN);
  return fetch('https://graph.facebook.com/me/messages?' + qs, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body,
  })
  .then(rsp => rsp.json())
  .then(json => {
    if (json.error && json.error.message) {
      throw new Error(json.error.message);
    }
    return json;
  });
};


const findEntityValue = (entities, entity) => {
  const val = entities && entities[entity] &&
    Array.isArray(entities[entity]) &&
    entities[entity].length > 0 &&
    entities[entity][0].value
  ;
  if (!val) {
    return null;
  }
  return typeof val === 'object' ? val.value : val;
};

// ----------------------------------------------------------------------------
// Wit.ai bot specific code

// This will contain all user sessions.
// Each session has an entry:
// sessionId -> {f};

const sessions = {};

const findOrCreateSession = (fbid) => {
  let sessionId;
  // Let's see if we already have a session for the user fbid
  Object.keys(sessions).forEach(k => {
    if (sessions[k].fbid === fbid) {
      // Yep, got it!
      sessionId = k;
    }
  });
  if (!sessionId) {
    // No session found for user fbid, let's create a new one
    sessionId = new Date().toISOString();
    sessions[sessionId] = {fbid: fbid, context: {}};
  }
  return sessionId;
};

function sendTextMessage(sender, text) {
    let messageData = { text:text }
    request({
        url: 'https://graph.facebook.com/v2.6/me/messages',
        qs: {access_token:FB_PAGE_TOKEN},
        method: 'POST',
        json: {
            recipient: {id:sender},
            message: messageData,
        }
    }, function(error, response, body) {
        if (error) {
            console.log('Error sending messages: ', error)
        } else if (response.body.error) {
            console.log('Error: ', response.body.error)
        }
    })
}



// Our bot actions
const actions = {
  send({sessionId}, {text}) {
    // Our bot has something to say!
    // Let's retrieve the Facebook user whose session belongs to
    const recipientId = sessions[sessionId].fbid;
    if (recipientId) {
      console.log("the below is for text");
      console.log(typeof text);
      sendTextMessage(recipientId,text);

      // Yay, we found our recipient!
      // Let's forward our bot response to her.
      // We return a promise to let our bot know when we're done sending
      // return fbMessage(recipientId, text)
      // .then(() => null)
      // .catch((err) => {
      //   console.error(
      //     'Oops! An error occurred while forwarding the response to',
      //     recipientId,
      //     ':',
      //     err.stack || err
      //   );
      // });
    } else {
      console.error('Oops! Couldn\'t find user for session:', sessionId);
      // Giving the wheel back to our bot
      return Promise.resolve()
    }
  },
  optiongenerator({context, entities}) {
    var user_intent = findEntityValue(entities, 'intent');
    if (user_intent == 'book') {
      var message = {
        text: 'Favorite color?',
        buttons: [
          { type: 'postback', title: 'Red', payload: 'FAVORITE_RED' },
          { type: 'postback', title: 'Blue', payload: 'FAVORITE_BLUE' },
          { type: 'postback', title: 'Green', payload: 'FAVORITE_GREEN' }
        ]
      };
      var output = buttonGenerator(message.text,message.buttons);
      context.options = output;


    return context;
    }
  },
  // You should implement your custom actions here
  // See https://wit.ai/docs/quickstart
};

// Setting up our bot
const wit = new Wit({
  accessToken: WIT_TOKEN,
  actions,
  logger: new log.Logger(log.INFO)
});

// Starting our webserver and putting it all together
const app = express();
app.use(({method, url}, rsp, next) => {
  rsp.on('finish', () => {
    console.log(`${rsp.statusCode} ${method} ${url}`);
  });
  next();
});
app.use(bodyParser.json({ verify: verifyRequestSignature }));

// Webhook setup
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === FB_VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(400);
  }
});

// Message handler
app.post('/webhook', (req, res) => {
  // Parse the Messenger payload
  // See the Webhook reference
  // https://developers.facebook.com/docs/messenger-platform/webhook-reference
  const data = req.body;

  if (data.object === 'page') {
    data.entry.forEach(entry => {
      entry.messaging.forEach(event => {
        if (event.message && !event.message.is_echo) {
          // Yay! We got a new message!
          // We retrieve the Facebook user ID of the sender
          const sender = event.sender.id;

          // We retrieve the user's current session, or create one if it doesn't exist
          // This is needed for our bot to figure out the conversation history
          const sessionId = findOrCreateSession(sender);

          // We retrieve the message content
          const {text, attachments} = event.message;

          if (attachments) {
            // We received an attachment
            // Let's reply with an automatic message
            fbMessage(sender, 'Sorry I can only process text messages for now.')
            .catch(console.error);
          } else if (text) {



            var message = {
              text: 'Favorite color?',
              buttons: [
                { type: 'postback', title: 'Red', payload: 'FAVORITE_RED' },
                { type: 'postback', title: 'Blue', payload: 'FAVORITE_BLUE' },
                { type: 'postback', title: 'Green', payload: 'FAVORITE_GREEN' }
              ]
            };
            var output = buttonGenerator(message.text,message.buttons);
            sendTextMessage(sender,output);


            // We received a text message

              // wit.converse(sessionId, text, sessions[sessionId].context)
              //   .then((data) => {
              //   console.log('Yay, got Wit.ai response: ' + JSON.stringify(data));
              //   })
              //   .catch(console.error);

              // Let's forward the message to the Wit.ai Bot Engine
              // This will run all actions until our bot has nothing left to do
              // wit.runActions(
              //   sessionId, // the user's current session
              //   text, // the user's message
              //   sessions[sessionId].context // the user's current session state
              // ).then((context) => {
              //   // Our bot did everything it has to do.
              //   // Now it's waiting for further messages to proceed.
              //   console.log('Waiting for next user messages');

              //   // Based on the session state, you might want to reset the session.
              //   // This depends heavily on the business logic of your bot.
              //   // Example:
              //   // if (context['done']) {
              //   //   delete sessions[sessionId];
              //   // }

              //   // Updating the user's current session state
              //   sessions[sessionId].context = context;
              // })
              // .catch((err) => {
              //   console.error('Oops! Got an error from Wit: ', err.stack || err);
              // })
          }
        } else {
          console.log('received event', JSON.stringify(event));
        }
      });
    });
  }
  res.sendStatus(200);
});

function formatButtons(buttons) {
  return buttons && buttons.map((button) => {
    if (typeof button === 'string') {
      return {
        type: 'postback',
        title: button,
        payload: 'BOOTBOT_BUTTON_' + normalizeString(button)
      };
    } else if (button && button.title) {
      return button;
    }
    return {};
  });
}

function makeTemplate(payload) {
  const message = {
    attachment: {
      type: 'template',
      payload
    }
  };
  return message;
}


function buttonGenerator(text,buttons){
  const payload = {
    template_type: 'button',
    text
  };
  const formattedButtons = formatButtons(buttons);
  payload.buttons = formattedButtons;
  return makeTemplate(payload);
}

function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];
  if (!signature) {
    console.error("Couldn't validate the signature.");
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', FB_APP_SECRET)
                        .update(buf)
                        .digest('hex');

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

app.listen(PORT);
console.log('Listening on :' + PORT + '...');

