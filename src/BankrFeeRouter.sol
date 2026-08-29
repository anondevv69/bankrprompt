// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IDopplerFees {
    function collectFees(bytes32 poolId) external returns (uint256 amount0, uint256 amount1);
}

/// @title BankrFeeRouter
/// @notice Routes claimed Bankr/Clanker fees on Base.
/// Paired asset (BNKR or WETH) → ops wallet. Project token → renewer distributor.
contract BankrFeeRouter {
    address public immutable WETH;
    address public immutable PAIRED_TOKEN;
    address public immutable OPS_RECIPIENT;
    address public immutable PROJECT_TOKEN;
    address public immutable DISTRIBUTOR;

    event OpsRouted(address indexed token, address indexed to, uint256 amount);
    event TokenRouted(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error TransferFailed();
    error NothingToRoute();

    constructor(
        address weth_,
        address pairedToken_,
        address opsRecipient_,
        address projectToken_,
        address distributor_
    ) {
        if (weth_ == address(0) || pairedToken_ == address(0) || opsRecipient_ == address(0) || distributor_ == address(0)) {
            revert ZeroAddress();
        }
        WETH = weth_;
        PAIRED_TOKEN = pairedToken_;
        OPS_RECIPIENT = opsRecipient_;
        PROJECT_TOKEN = projectToken_;
        DISTRIBUTOR = distributor_;
    }

    function _opsToken(address token) internal view returns (bool) {
        return token == WETH || token == PAIRED_TOKEN;
    }

    /// @notice Forward WETH, paired token, and project token balances.
    function route() external returns (uint256 opsAmount, uint256 tokenAmount) {
        opsAmount = _routeBalance(WETH);
        opsAmount += _routeBalance(PAIRED_TOKEN);

        if (PROJECT_TOKEN != address(0)) {
            tokenAmount = _routeBalanceTo(PROJECT_TOKEN, DISTRIBUTOR);
        }

        if (opsAmount == 0 && tokenAmount == 0) revert NothingToRoute();
    }

    /// @notice Forward one token. Ops assets → OPS_RECIPIENT, project token → DISTRIBUTOR.
    function routeToken(address token) external returns (uint256 amount) {
        if (token == address(0)) revert ZeroAddress();
        amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) revert NothingToRoute();
        address to = _opsToken(token) ? OPS_RECIPIENT : DISTRIBUTOR;
        if (!IERC20(token).transfer(to, amount)) revert TransferFailed();
        if (_opsToken(token)) emit OpsRouted(token, to, amount);
        else emit TokenRouted(token, to, amount);
    }

    function _routeBalance(address token) internal returns (uint256 amount) {
        return _routeBalanceTo(token, OPS_RECIPIENT);
    }

    function _routeBalanceTo(address token, address to) internal returns (uint256 amount) {
        amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) return 0;
        if (!IERC20(token).transfer(to, amount)) revert TransferFailed();
        if (_opsToken(token)) emit OpsRouted(token, to, amount);
        else emit TokenRouted(token, to, amount);
    }

    /// @notice Claim Doppler/Bankr pool fees when this contract is fee beneficiary.
    function claimDoppler(address initializer, bytes32 poolId)
        external
        returns (uint256 amount0, uint256 amount1)
    {
        if (initializer == address(0)) revert ZeroAddress();
        return IDopplerFees(initializer).collectFees(poolId);
    }
}
