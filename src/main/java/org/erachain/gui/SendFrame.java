package org.erachain.gui;

import org.erachain.core.account.Account;
import org.erachain.core.item.assets.AssetCls;
import org.erachain.lang.Lang;

import javax.swing.*;
import java.awt.*;

//import org.erachain.gui.*;
//import org.erachain.gui.*;
//import org.erachain.gui.*;

public class SendFrame extends JInternalFrame {


    /**
     *
     */
    private static final long serialVersionUID = 1L;

    public SendFrame(AssetCls asset, Account account) {

        this.setFrameIcon(new ImageIcon(Toolkit.getDefaultToolkit().getImage("images/icons/icon16.png")));
        SendPanel panel = new SendPanel(asset, account);
        getContentPane().add(panel, BorderLayout.CENTER);

        //SHOW FRAME
        this.pack();
        this.setMaximizable(true);
        this.setTitle(Lang.getInstance().translate("Send"));
        this.setClosable(true);
        this.setResizable(true);
        //this.setSize(new Dimension( (int)parent.getSize().getWidth()-80,(int)parent.getSize().getHeight()-150));
        this.setLocation(20, 20);
        //	this.setIconImages(icons);
        //CLOSE
        setDefaultCloseOperation(JInternalFrame.DISPOSE_ON_CLOSE);
        this.setResizable(true);
//        splitPane_1.setDividerLocation((int)((double)(this.getHeight())*0.7));//.setDividerLocation(.8);
        this.setVisible(true);

    }

}