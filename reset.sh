#!/bin/bash
# Reset loopy conversation and plan files

echo "Resetting loopy..."

rm -f conversation.log
echo "✓ Deleted conversation.log"

rm -f conversation.txt
echo "✓ Deleted conversation.txt"

rm -f context/plan.txt
echo "✓ Deleted context/plan.txt"

echo "Done! Ready for a fresh start."
