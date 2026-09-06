# Test the edit-tool-fix plugin behavior

This script simulates what the plugin does when it receives edit tool calls.

## Test Case 1: Mixed slashes in path
Input:  "C:\\Users\\User/Desktop/EXPERIMENTS/test.md"
Expected: "C:\\Users\\User\\Desktop\\EXPERIMENTS\\test.md"

## Test Case 2: Trailing quote in path  
Input:  "C:\\Users\\User\\test.md\""
Expected: "C:\\Users\\User\\test.md"

## Test Case 3: CRLF line endings in oldString
Input:  "Line 1\r\nLine 2\r\nLine 3"
Expected: "Line 1\nLine 2\nLine 3"

## Test Case 4: Multiple backslashes
Input:  "C:\\Users\\User\\\\Desktop\\test.md"
Expected: "C:\\Users\\User\\Desktop\\test.md"

## Real-world examples from your database:

### Example 1: FolderContent.razor with mixed slashes
Original: "C:\\Users\\User\\Desktop/EXPLORER/Alvit/Components/Windows/FolderContent.razor"
Fixed:    "C:\\Users\\User\\Desktop\\EXPLORER\\Alvit\\Components\\Windows\\FolderContent.razor"

### Example 2: Trailing quote in path
Original: "C:\\Users/User/Desktop/EXPERIMENTS/EXPLORER/Alvit/Components/Windows/FolderContent.razor""
Fixed:    "C:\\Users\\User\\Desktop\\EXPERIMENTS\\EXPLORER\\Alvit\\Components\\Windows\\FolderContent.razor"

### Example 3: CRLF mismatch (most common failure)
The edit tool requires exact matching. If the file has CRLF line endings but the model
provides oldString with LF, the edit fails.

File content: "private void Foo()\r\n{\r\n    Bar();\r\n}"
Model oldString: "private void Foo()\n{\n    Bar();\n}"
Result: FAIL (line endings don't match)

Plugin fix: Normalize oldString to match file's line endings.
