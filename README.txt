IOS COMMAND MATCH — VERSION 1.1
================================

WHAT CHANGED
------------
This version uses the complete data from:
CCNA_Command_Knowledge_Base_Initial_Library.xlsx

The Excel workbook remains the editable master source. The browser game loads:
- commands.json (23 command master records)
- questions.json (115 scenario/objective records)

HOW TO RUN
----------
1. Open this folder in Visual Studio Code.
2. Right-click index.html.
3. Choose Open with Live Server.
4. Select Start 10-Minute Game.

HOW THE DATA FLOW WORKS
-----------------------
Excel workbook -> JSON conversion -> browser game

Do not attempt to make the public website load the .xlsx workbook directly. JSON is smaller,
faster, and easier for browsers to validate. When the workbook is updated, regenerate the two
JSON files and replace them in this folder before publishing the next version.

CURRENT CONTENT
---------------
23 commands
115 questions
5 questions per command
4 progressive difficulty stages
