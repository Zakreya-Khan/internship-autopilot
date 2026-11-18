#!/bin/bash
# Double-click to start Internship Autopilot (macOS). It builds what's missing, starts the
# local server (this computer only) and opens the review UI in your browser.
# Close this window, or press Ctrl-C, to stop it.
cd "$(dirname "$0")" || exit 1
if ! command -v npm >/dev/null 2>&1; then
  # Finder starts this without your shell's PATH: add the usual Node locations.
  export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$PATH"
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js isn't installed. Install Node 22.13 or newer from https://nodejs.org, then try again."
  read -r -p "Press Return to close."
  exit 1
fi
npm start
status=$?
if [ $status -ne 0 ]; then read -r -p "Something went wrong (see above). Press Return to close."; fi
exit $status
