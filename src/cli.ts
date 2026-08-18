async function main(): Promise<void> {
  console.log("animbench");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
