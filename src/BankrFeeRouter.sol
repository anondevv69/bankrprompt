// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title BankrFeeRouter
/// @notice Routes claimed Bankr/Clanker fees on Base.
/// WETH → ops wallet. Project token → renewer distributor.
contract BankrFeeRouter {
    address public immutable WETH;
    address public immutable WETH_RECIPIENT;
    address public immutable PROJECT_TOKEN;
    address public immutable DISTRIBUTOR;

    event WethRouted(address indexed to, uint256 amount);
    event TokenRouted(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error TransferFailed();
    error NothingToRoute();

    constructor(address weth_, address wethRecipient_, address projectToken_, address distributor_) {
        if (weth_ == address(0) || wethRecipient_ == address(0) || distributor_ == address(0)) {
            revert ZeroAddress();
        }
        WETH = weth_;
        WETH_RECIPIENT = wethRecipient_;
        PROJECT_TOKEN = projectToken_;
        DISTRIBUTOR = distributor_;
    }

    function route() external returns (uint256 wethAmount, uint256 tokenAmount) {
        wethAmount = IERC20(WETH).balanceOf(address(this));
        if (wethAmount > 0) {
            if (!IERC20(WETH).transfer(WETH_RECIPIENT, wethAmount)) revert TransferFailed();
            emit WethRouted(WETH_RECIPIENT, wethAmount);
        }

        if (PROJECT_TOKEN != address(0)) {
            tokenAmount = IERC20(PROJECT_TOKEN).balanceOf(address(this));
            if (tokenAmount > 0) {
                if (!IERC20(PROJECT_TOKEN).transfer(DISTRIBUTOR, tokenAmount)) revert TransferFailed();
                emit TokenRouted(PROJECT_TOKEN, DISTRIBUTOR, tokenAmount);
            }
        }

        if (wethAmount == 0 && tokenAmount == 0) revert NothingToRoute();
    }

    function routeToken(address token) external returns (uint256 amount) {
        if (token == address(0)) revert ZeroAddress();
        amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) revert NothingToRoute();
        address to = token == WETH ? WETH_RECIPIENT : DISTRIBUTOR;
        if (!IERC20(token).transfer(to, amount)) revert TransferFailed();
        if (token == WETH) emit WethRouted(to, amount);
        else emit TokenRouted(token, to, amount);
    }
}
