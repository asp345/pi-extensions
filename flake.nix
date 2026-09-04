{
  description = "Development shell for the personal Pi monorepo";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          typescriptLanguageServerBun = pkgs.writeShellScriptBin "typescript-language-server" ''
            exec ${pkgs.bun}/bin/bun ${pkgs.typescript-language-server}/lib/node_modules/typescript-language-server/lib/cli.mjs "$@"
          '';
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              bun
              nixfmt
              typescriptLanguageServerBun
            ];

            # Appended, not prepended: prepending would shadow the
            # home-manager pi with the node_modules copy, whose asset layout
            # breaks against PI_PACKAGE_DIR.
            shellHook = ''
              export PATH="$PATH:$PWD/node_modules/.bin"
            '';
          };
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
