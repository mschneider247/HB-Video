# HabitBeast Veo Fight Generator

Generate cartoon monster fight videos using Google Veo via the Gemini API.

## Setup

### 1. Install dependencies
```powershell
npm install
```

### 2. Set your API key (PowerShell)
```powershell
# Current session only
$env:GEMINI_API_KEY = "your-key-here"

# Permanent (survives restarts — then close and reopen terminal)
[System.Environment]::SetEnvironmentVariable("GEMINI_API_KEY", "your-key-here", "User")
```

## Usage

```powershell
# Default fight (Frank vs Wrapps)
npx ts-node generate.ts

# Preset fights
npx ts-node generate.ts frank-vs-wrapps
npx ts-node generate.ts iggs-vs-wolf
npx ts-node generate.ts murk-vs-stumbles

# Custom prompt
npx ts-node generate.ts "your custom prompt here"
```

## Preset Fights
| Command | Fighters |
|---------|---------|
| `frank-vs-wrapps` | Fat Frankenstein vs Glowing-Eye Mummy |
| `iggs-vs-wolf` | Tiny Cyclops vs Dopey Werewolf |
| `murk-vs-stumbles` | Hippo Swamp Monster vs Grinning Zombie |

## Output
Videos are saved as `.mp4` files in the project folder with a timestamp in the filename.
