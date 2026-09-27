#!/bin/bash
git commit -m "Initial commit"
git branch -M main
git remote remove origin 2>/dev/null
git remote add origin https://github.com/SuckADick907/Claude.git
git push -u origin main
