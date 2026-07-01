pragma circom 2.1.0;

include "../lib/note.circom";

component main {public [privKey, amount, blindness]} = Note();
