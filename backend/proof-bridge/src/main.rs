use clap::{Parser, Subcommand};
use num_bigint::BigInt;
use num_traits::Num;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// SnarkJS Proof structure
#[derive(Debug, Deserialize)]
struct SnarkJsProof {
    pi_a: Vec<String>,
    pi_b: Vec<Vec<String>>,
    pi_c: Vec<String>,
    protocol: String,
}

#[derive(Parser)]
#[command(name = "proof-bridge")]
#[command(about = "Converts SnarkJS JSON proofs to raw binary for Soroban Verifier", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Convert a SnarkJS proof.json to binary
    ConvertProof {
        #[arg(short, long)]
        input: PathBuf,
        #[arg(short, long)]
        output: PathBuf,
    },
    /// Format a SnarkJS public.json for CLI use
    FormatPublic {
        #[arg(short, long)]
        input: PathBuf,
    },
}

/// Convert a decimal string from SnarkJS into a big-endian 32-byte array
fn parse_field_element(s: &str) -> [u8; 32] {
    let bi = BigInt::from_str_radix(s, 10).expect("Invalid decimal string");
    let (_, bytes) = bi.to_bytes_be();
    let mut padded = [0u8; 32];
    if bytes.len() > 32 {
        panic!("Field element too large");
    }
    // padding at the beginning because it's big-endian
    padded[32 - bytes.len()..].copy_from_slice(&bytes);
    padded
}

fn convert_proof(input: PathBuf, output: PathBuf) {
    let content = fs::read_to_string(&input).expect("Failed to read input file");
    let proof: SnarkJsProof = serde_json::from_str(&content).expect("Failed to parse JSON");

    if proof.protocol != "groth16" {
        panic!("Only groth16 protocol is supported");
    }

    let mut out_bytes = Vec::new();

    // A ∈ G1: x, y (pi_a[0], pi_a[1])
    out_bytes.extend_from_slice(&parse_field_element(&proof.pi_a[0]));
    out_bytes.extend_from_slice(&parse_field_element(&proof.pi_a[1]));

    // B ∈ G2: x, y where x = c1 * u + c0 (pi_b[0][1], pi_b[0][0]) and y = c1 * u + c0 (pi_b[1][1], pi_b[1][0])
    // Note: SnarkJS G2 formatting puts [c0, c1].
    // Soroban expects c1, c0, c1, c0 for (X, Y).
    // Let's inspect the SnarkJS output: pi_b is usually [[x0, x1], [y0, y1]].
    // Actually, in SnarkJS, it's [[c0, c1], [c0, c1]] for X and Y.
    // BN254 G2 coordinates are elements of Fp2. Fp2 element is a0 + a1 * u.
    // We need to output c1 then c0 for X, then c1 then c0 for Y to match big-endian Fp2 formatting commonly used.
    out_bytes.extend_from_slice(&parse_field_element(&proof.pi_b[0][1]));
    out_bytes.extend_from_slice(&parse_field_element(&proof.pi_b[0][0]));
    out_bytes.extend_from_slice(&parse_field_element(&proof.pi_b[1][1]));
    out_bytes.extend_from_slice(&parse_field_element(&proof.pi_b[1][0]));

    // C ∈ G1: x, y (pi_c[0], pi_c[1])
    out_bytes.extend_from_slice(&parse_field_element(&proof.pi_c[0]));
    out_bytes.extend_from_slice(&parse_field_element(&proof.pi_c[1]));

    fs::write(&output, &out_bytes).expect("Failed to write output file");

    let hex_str = hex::encode(&out_bytes);
    println!("Successfully converted proof.");
    println!("Hex format: {}", hex_str);
}

fn format_public(input: PathBuf) {
    let content = fs::read_to_string(&input).expect("Failed to read input file");
    let pi: Vec<String> = serde_json::from_str(&content).expect("Failed to parse JSON");

    println!("Formatted public inputs for CLI:");
    for (i, val) in pi.iter().enumerate() {
        let bytes = parse_field_element(val);
        println!("Input [{}]: {{\"bytes\":\"{}\"}}", i, hex::encode(&bytes));
    }
}

fn main() {
    let cli = Cli::parse();

    match cli.command {
        Commands::ConvertProof { input, output } => convert_proof(input, output),
        Commands::FormatPublic { input } => format_public(input),
    }
}
