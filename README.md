# myPA

An Android personal-secretary app built with Expo / React Native. Your assistant is called **Jolly** by default, and you can rename it in Settings.

Most of the app works **without AI or any API**. Claude chat is optional.

## Features

- **Executive-assistant tools**: a **Chase** list for what others owe you (with a one-tap nudge by SMS or WhatsApp and a chase reminder), **People** cards with notes and check-in reminders, meeting prep and wrap-up, task priorities and delegation (optionally auto-texting the owner for an update), clash and free-slot detection, an optional read-only link to your phone calendar, a richer morning briefing and an evening wrap-up. Jolly can draft messages for you to review and send.
- **Agenda**: tasks, events and a notebook. Everything can be added and edited by hand, with date/time pickers and daily/weekly/monthly repeats.
- **Reminders**: local notifications for tasks and events, plus an optional daily morning briefing.
- **Scheduled texts**: SMS sent by a native alarm at the set time, even when the app is closed. Supports several recipients (up to 25), SIM choice and repeats.
- **Scheduled calls**: placed at the set time from the SIM you choose.
- **WhatsApp reminders**: at the set time a notification opens the chat with your message pre-filled. WhatsApp can't be sent automatically. Numbers need a country code, e.g. `+255…`.
- **Fake call**: a realistic incoming-call screen on your own phone, with your ringtone. It never calls anyone.
- **Home-screen widget**: today's agenda, with a shortcut to add a task.
- **Voice input** and **dark mode**.
- **Chat with Jolly** (optional): choose Claude or Gemini in Settings and enter your own API key for it. Keys are stored encrypted on the device, and you can switch provider at any time.

Sent-text notifications never show the number or message.

## Setup

```bash
npm install
```

This app uses native code (a local Kotlin module, speech recognition, widgets, notifications), so it **does not run in Expo Go**. Use an EAS build:

```bash
# installable APK for testing
npx eas-cli build --profile preview --platform android

# development client (hot reload, needs `npx expo start`)
npx eas-cli build --profile development --platform android
```

The build page gives an install link and QR code. Uninstall any older build first if the install fails.

## Making scheduled texts and calls reliable

After installing, open the **Messages** tab and finish the setup card:

1. Allow **SMS** (and **Phone** for calls and SIM choice).
2. Allow **exact alarms**.
3. Turn off **battery optimisation** for myPA.
4. For automatic calls, allow **Display over other apps**. Without it you get a tap-to-call notification instead.
5. If you installed the APK outside the Play Store, Android 13+ may block SMS permission. Open App info → ⋮ → **Allow restricted settings**.

A call that is more than a minute late (a text, more than 10 minutes) after a reboot is marked **Missed** instead of being sent.

Test with a text or call a few minutes ahead, addressed to your own number.

## Limits

- Android only.
- Android may ask you to confirm after about 30 texts in 30 minutes, and carriers may throttle bulk texts. Only message people who expect it.
- No caller-ID spoofing.

## Project layout

```
App.js                  all screens and UI
index.js                entry point, registers the widget task
src/claude.js           Claude tool-use loop
src/comms.js            texts, calls, permissions (bridge to the native module)
src/dates.js            dates and repeats
src/reminders.js        notification scheduling
src/storage.js          data, API key, preferences
src/voice.js            speech recognition
src/ContactPicker.js    in-app contact picker
src/widget/             home-screen widget
modules/mypa-native/    Kotlin module: alarms, SMS, calls, ringtone, boot recovery
```

## Checks

```bash
npx tsc --noEmit
npx expo lint
npx expo-doctor
```
