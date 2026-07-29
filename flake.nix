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
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              biome
              nixd
              nixfmt
              nodejs_24
              typescript-language-server
            ];

            PI_BIOME_LSP_COMMAND = "${pkgs.biome}/bin/biome lsp-proxy";
            PI_NIXD_LSP_COMMAND = "${pkgs.nixd}/bin/nixd";

            # Appended, not prepended: @earendil-works/pi-coding-agent is a
            # devDependency for its types, and npm links its `pi` bin into
            # node_modules/.bin. Prepending would shadow the home-manager pi
            # with that copy, whose asset layout differs from the packaged
            # build and breaks against PI_PACKAGE_DIR.
            shellHook = ''
              export PATH="$PATH:$PWD/node_modules/.bin"
            '';
          };
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
