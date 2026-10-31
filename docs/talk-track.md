# Talk track: PingOne LAB

About 12 minutes for the core cards; each card also stands alone. Use **Mock** to rehearse or when there is no
PingOne environment to hand (nothing leaves the laptop); use **Live** to show your own PingOne. Say which one is on:
the banner always does, and Presenter mode keeps it on screen.

## Before you start

1. Run `npm run doctor`. Every line should say `ok`.
2. Open http://127.0.0.1:5500 (https when you run it in Docker). Pick Mock or Live in the header. In Mock the
   sign-in dialog shows the demo user.
3. Pick a workspace name for this session in the header (for example `acme-demo`). `npm run reset` clears only that
   workspace, so a second presenter on the same laptop keeps their runs.
4. Optional: press **Presenter** to hide the chrome, **Esc** brings it back.

## The story (one minute)

"PingOne already runs your sign-in. This page shows what it can do for apps and AI agents, and only what it can do:
each card is one standard that PingOne's own discovery document advertises, run with every request and response on
screen. Secrets are blanked on the server; tokens show their decoded claims (in Mock the fake tokens are shown whole, so you can paste one into a decoder; in Live they are masked). If PingOne does not advertise it, there
is no card."

## The cards, in shelf order

1. **Sign in (pi.flow).** The app draws its own sign-in; PingOne still decides. Click Run (or Sign in in the header).
   Show the first JSON (a flow with a status) and the answer after the password. Point at `COMPLETED`, then the
   resume call that hands back the code. Try a wrong password: PingOne refuses it (`INVALID_CREDENTIALS`) and the
   flow keeps waiting.
2. **PKCE, PAR, JAR.** Three ways to protect the authorization request. PKCE binds the code to the app that asked,
   PAR sends the parameters straight to PingOne, JAR signs them. Run each and compare the traces.
3. **Client credentials.** An agent with no user gets its own token: no sign-in, no person involved. Show the scope it was granted.
4. **Token lifecycle.** Refresh, introspect, revoke, then try the revoked refresh token: PingOne must refuse it. The
   card shows "refused as expected".
5. **Userinfo.** The signed-in user's claims straight from PingOne (needs a sign-in first). In Mock they come from the
   demo user.
6. **Device authorization.** A token for something with no browser: show the user code and the link, then the poll.
   In Mock the "other device" approves itself after a couple of polls.
7. **CIBA (start and poll).** The request starts on the lab; the person approves on their own device, not in the
   agent's window. The lab has no approve button: it only polls.
8. **Token exchange.** The user's token becomes a new token for another audience; with an actor set, `act` names who
   is acting for whom.
9. **Flows API.** Opens a pi.flow and reads it without sending a password; the guide beside it explains each field.
10. **Playground.** Pick a protocol, change a parameter, run it, compare. Good for questions from the room.

## "Why no DPoP, RAR or dynamic client registration?"

Say it plainly: "PingOne's discovery document does not advertise them, so this lab does not pretend." The Settings
page's discovery check lists them as "not advertised". PingFederate's lab has those cards.

## Mock versus live, in one sentence

"Mock is a stand-in so you can rehearse anywhere; Live is your real PingOne, and then every trace is real." Switching
signs everyone out, on purpose.

## If something goes wrong

- A card says what setting it needs; open Settings from the card.
- "Not advertised" means this PingOne does not offer that feature; nothing is broken.
- A pi.flow that says the sign-in expired (404) is older than 15 minutes; press Run again.
