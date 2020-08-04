package org.erachain.gui2;

import org.erachain.core.BlockChain;
import org.erachain.gui.Wallets.WalletsManagerSplitPanel;
import org.erachain.gui.bank.IssueSendPaymentOrder;
import org.erachain.gui.bank.MyOrderPaimentsSplitPanel;
import org.erachain.gui.items.accounts.FavoriteAccountsSplitPanel;
import org.erachain.gui.items.accounts.MyAccountsSplitPanel;
import org.erachain.gui.items.accounts.MyLoansSplitPanel;
import org.erachain.gui.items.assets.*;
import org.erachain.gui.items.imprints.ImprintsFavoriteSplitPanel;
import org.erachain.gui.items.imprints.ImprintsSearchSplitPanel;
import org.erachain.gui.items.imprints.IssueImprintPanel;
import org.erachain.gui.items.imprints.MyImprintsTab;
import org.erachain.gui.items.link_hashes.IssueLinkedHashPanel;
import org.erachain.gui.items.mails.IncomingMailsSplitPanel;
import org.erachain.gui.items.mails.MailSendPanel;
import org.erachain.gui.items.mails.OutcomingMailsSplitPanel;
import org.erachain.gui.items.other.OtherConsolePanel;
import org.erachain.gui.items.other.OtherSearchBlocks;
import org.erachain.gui.items.other.OtherSplitPanel;
import org.erachain.gui.items.persons.*;
import org.erachain.gui.items.polls.IssuePollPanel;
import org.erachain.gui.items.polls.PollsFavoriteSplitPanel;
import org.erachain.gui.items.polls.Polls_My_SplitPanel;
import org.erachain.gui.items.polls.SearchPollsSplitPanel;
import org.erachain.gui.items.records.FavoriteTransactionsSplitPanel;
import org.erachain.gui.items.records.MyTransactionsSplitPanel;
import org.erachain.gui.items.records.SearchTransactionsSplitPanel;
import org.erachain.gui.items.records.UnconfirmedTransactionsPanel;
import org.erachain.gui.items.statement.FavoriteStatementsSplitPanel;
import org.erachain.gui.items.statement.IssueDocumentPanel;
import org.erachain.gui.items.statement.SearchStatementsSplitPanel;
import org.erachain.gui.items.statement.StatementsMySplitPanel;
import org.erachain.gui.items.statuses.IssueStatusPanel;
import org.erachain.gui.items.statuses.SearchStatusesSplitPanel;
import org.erachain.gui.items.statuses.StatusesFavoriteSplitPanel;
import org.erachain.gui.items.templates.IssueTemplatePanel;
import org.erachain.gui.items.templates.SearchTemplatesSplitPanel;
import org.erachain.gui.items.templates.TemplateMySplitPanel;
import org.erachain.gui.items.templates.TemplatesFavoriteSplitPanel;
import org.erachain.gui.items.unions.IssueUnionPanel;
import org.erachain.gui.items.unions.MyUnionsTab;
import org.erachain.gui.items.unions.SearchUnionSplitPanel;
import org.erachain.gui.library.MSplitPane;
import org.erachain.gui.telegrams.ALLTelegramPanel;
import org.erachain.gui.telegrams.TelegramSplitPanel;
import org.erachain.lang.Lang;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.swing.*;
import javax.swing.event.TreeSelectionEvent;
import javax.swing.event.TreeSelectionListener;
import javax.swing.tree.DefaultMutableTreeNode;
import javax.swing.tree.TreePath;
import java.awt.*;
import java.awt.event.KeyEvent;
import java.awt.event.KeyListener;
import java.awt.event.MouseEvent;
import java.awt.event.MouseListener;
import java.util.Enumeration;

/*
 * To change this license header, choose License Headers in Project Properties.
 * To change this template file, choose Tools | Templates
 * and open the template in the editor.
 */

/**
 * @author ����
 */
public class MainPanel extends javax.swing.JPanel {

    /**
     *
     */
    private static final long serialVersionUID = 1L;
    private static MainPanel instance;
    public MainLeftPanel mlp;
    public MSplitPane jSplitPane1;
    public MTabbedPanel jTabbedPane1;

    protected Logger logger = LoggerFactory.getLogger(this.getClass());

    private MainPanel() {
        initComponents();
        //       jSplitPane1.M_setDividerSize(40);
    }

    // Variables declaration - do not modify

    /**
     * Creates new form split_1
     */

    public static MainPanel getInstance() {
        if (instance == null) {
            instance = new MainPanel();
        }

        return instance;

    }

    /**
     * This method is called from within the constructor to initialize the form.
     * WARNING: Do NOT modify this code. The content of this method is always
     * regenerated by the Form Editor.
     */

    // <editor-fold defaultstate="collapsed" desc="Generated Code">
    private void initComponents() {
        java.awt.GridBagConstraints gridBagConstraints;

        jSplitPane1 = new MSplitPane();
        jSplitPane1.set_CloseOnOneTouch(jSplitPane1.ONE_TOUCH_CLOSE_LEFT_TOP); // set
        // one
        // touch
        // close
        // LEFT
        jTabbedPane1 = new MTabbedPanel(JTabbedPane.TOP, JTabbedPane.SCROLL_TAB_LAYOUT);
        mlp = new MainLeftPanel();
        jTabbedPane1.addMouseListener(new MouseListener() {

            @Override
            public void mouseClicked(MouseEvent arg0) {
                // TODO Auto-generated method stub

            }

            @Override
            public void mouseEntered(MouseEvent arg0) {
                // TODO Auto-generated method stub

            }

            @Override
            public void mouseExited(MouseEvent arg0) {
                // TODO Auto-generated method stub

            }

            @Override
            public void mousePressed(MouseEvent arg0) {
                // TODO Auto-generated method stub
                Component cc = arg0.getComponent();
                if (cc.getClass().getSimpleName().equals("MTabbedPanel")) {
                    MTabbedPanel mt = (MTabbedPanel) cc;

                    // find path from name node
                    int index = mt.getSelectedIndex();
                    if (index >= 0) {
                        Component aa;
                        DefaultMutableTreeNode ss = getNodeByName(jTabbedPane1.getComponentAt(mt.getSelectedIndex()).getClass().getSimpleName(),
                                (DefaultMutableTreeNode) mlp.tree.tree.getModel().getRoot());
                        // set select from tree
                        if (ss != null)
                            mlp.tree.tree.setSelectionPath(new TreePath(ss.getPath()));
                    }
                }
            }

            @Override
            public void mouseReleased(MouseEvent arg0) {
                // TODO Auto-generated method stub

            }

        });

        mlp.tree.tree.addKeyListener(new KeyListener() {

            @Override
            public void keyPressed(KeyEvent arg0) {
                // TODO Auto-generated method stub
                if (arg0.getKeyCode() == KeyEvent.VK_ENTER) {
                    // find path from name node

                    addTab(mlp.tree.tree.getLastSelectedPathComponent().toString());
                }
            }

            @Override
            public void keyReleased(KeyEvent arg0) {
                // TODO Auto-generated method stub

            }

            @Override
            public void keyTyped(KeyEvent arg0) {
                // TODO Auto-generated method stub

            }

        });

        setLayout(new java.awt.GridBagLayout());

        jSplitPane1.setRightComponent(jTabbedPane1);

        mlp.tree.tree.addTreeSelectionListener(new TreeSelectionListener() {

            @Override
            public void valueChanged(TreeSelectionEvent e) {
                // TODO Auto-generated method stub

            }

        });

        mlp.tree.tree.addMouseListener(new MouseListener() {

            @Override
            public void mouseClicked(MouseEvent arg0) {
                // TODO Auto-generated method stub
                if (arg0.getClickCount() == 1) {

                    Component aa = arg0.getComponent();
                    if (aa.getClass().getSimpleName().equals("JTree")) {
                        JTree tr = ((JTree) aa);
                        if (tr.getLastSelectedPathComponent() == null)
                            return;
                        addTab(tr.getLastSelectedPathComponent().toString());

                    }
                    ;
                }
            }

            @Override
            public void mouseEntered(MouseEvent arg0) {
                // TODO Auto-generated method stub

            }

            @Override
            public void mouseExited(MouseEvent arg0) {
                // TODO Auto-generated method stub

            }

            @Override
            public void mousePressed(MouseEvent arg0) {
                // TODO Auto-generated method stub

            }

            @Override
            public void mouseReleased(MouseEvent arg0) {
                // TODO Auto-generated method stub

            }

        });

        /*
         * mlp.jButton1.addActionListener(new ActionListener(){
         *
         * @Override public void actionPerformed(ActionEvent arg0) { // TODO
         * Auto-generated method stub
         *
         *
         * int s = jTabbedPane1.indexOfTab("tab1");
         *
         *
         *
         *
         * if (s==-1) { jTabbedPane1.addTabWithCloseButton("tab1", new
         * JPanel()); s= jTabbedPane1.indexOfTab("tab1");
         *
         *
         * } jTabbedPane1.setSelectedIndex(s); }
         *
         *
         * });
         */
        mlp.setMinimumSize(new Dimension(0, 0));
        jSplitPane1.setLeftComponent(mlp);

        gridBagConstraints = new java.awt.GridBagConstraints();
        gridBagConstraints.fill = java.awt.GridBagConstraints.BOTH;
        gridBagConstraints.weightx = 0.1;
        gridBagConstraints.weighty = 0.1;
        add(jSplitPane1, gridBagConstraints);
        jSplitPane1.setDividerLocation(250);
    }// </editor-fold>
    // End of variables declaration

    // add tab from name
    public void addTab(String str) {

        try {
            if (str.equals(Lang.getInstance().translate("Send payment order")) || str.equals("IssueSendPaymentOrder")) {
                insertTab(Lang.getInstance().translate("Send Payment Order"), new IssueSendPaymentOrder(), IssueSendPaymentOrder.getIcon());
                return;
            }

            if (str.equals(Lang.getInstance().translate("My Payments Orders"))
                    || str.equals("MyOrderPaimentsSplitPanel")) {
                insertTab(Lang.getInstance().translate("My Payments Orders"), new MyOrderPaimentsSplitPanel(), MyOrderPaimentsSplitPanel.getIcon());
                return;
            }

            /////////// PERSONS
            if (str.equals(Lang.getInstance().translate("Favorite Persons")) || str.equals("PersonsFavoriteSplitPanel")) {
                insertTab(Lang.getInstance().translate("Favorite Persons"), new PersonsFavoriteSplitPanel(), PersonsFavoriteSplitPanel.getIcon());
                return;
            }
            if (str.equals(Lang.getInstance().translate("My Persons")) || str.equals("PersonsMySplitPanel")) {
                insertTab(Lang.getInstance().translate("My Persons"), new PersonsMySplitPanel(), PersonsMySplitPanel.getIcon());
                return;
            }
            if (str.equals(Lang.getInstance().translate("Search Persons")) || str.equals("SearchPersonsSplitPanel")) {
                insertTab(Lang.getInstance().translate("Search Persons"), new SearchPersonsSplitPanel(), SearchPersonsSplitPanel.getIcon());
                return;
            }
            if (str.equals(Lang.getInstance().translate("Issue Person")) || str.equals("IssuePersonPanel")) {
                insertTab(Lang.getInstance().translate("Issue Person"), new IssuePersonPanel(), IssuePersonPanel.getIcon());
                return;

            }
            if (str.equals(Lang.getInstance().translate("Insert Person")) || str.equals("InsertPersonPanel")) {
                insertTab(Lang.getInstance().translate("Insert Person"), new InsertPersonPanel(), InsertPersonPanel.getIcon());
                return;

            }

            if (str.equals(Lang.getInstance().translate("My Accounts")) || str.equals("MyAccountsSplitPanel")) {
                insertTab(Lang.getInstance().translate("My Accounts"), new MyAccountsSplitPanel(), MyAccountsSplitPanel.getIcon());
                return;

            }

            if (str.equals(Lang.getInstance().translate("My Loans")) || str.equals("MyLoansSplitPanel")) {
                insertTab(Lang.getInstance().translate("My Loans"), new MyLoansSplitPanel(), MyLoansSplitPanel.getIcon());
                return;

            }

            if (str.equals(Lang.getInstance().translate("Favorite Accounts"))
                    || str.equals("FavoriteAccountsSplitPanel")) {
                insertTab(Lang.getInstance().translate("Favorite Accounts"), new FavoriteAccountsSplitPanel(), FavoriteAccountsSplitPanel.getIcon());
                return;

            }

            // STATEMENTS
            if (str.equals(Lang.getInstance().translate("Favorite Documents"))
                    || str.equals("FavoriteStatementsSplitPanel")) {
                insertTab(Lang.getInstance().translate("Favorite Documents"), new FavoriteStatementsSplitPanel(), FavoriteStatementsSplitPanel.getIcon());
                return;
            }
            if (str.equals(Lang.getInstance().translate("My Documents")) || str.equals("StatementsMySplitPanel")) {
                insertTab(Lang.getInstance().translate("My Documents"), new StatementsMySplitPanel(), StatementsMySplitPanel.getIcon());
                return;

            }
            if (str.equals(Lang.getInstance().translate("Search Documents"))
                    || str.equals("SearchStatementsSplitPanel")) {
                insertTab(Lang.getInstance().translate("Search Documents"), new SearchStatementsSplitPanel(), SearchStatementsSplitPanel.getIcon());
                return;

            }
            if (str.equals(Lang.getInstance().translate("Issue Document")) || str.equals("IssueDocumentPanel")) {
                insertTab(Lang.getInstance().translate("Issue Document"), new IssueDocumentPanel(), IssueDocumentPanel.getIcon());
                return;

            }

            /// MAILS
            if (str.equals(Lang.getInstance().translate("Incoming Mails")) || str.equals("IncomingMailsSplitPanel")) {
                insertTab(Lang.getInstance().translate("Incoming Mails"), new IncomingMailsSplitPanel(), IncomingMailsSplitPanel.getIcon());
                return;
            }
            if (str.equals(Lang.getInstance().translate("Outcoming Mails")) || str.equals("OutcomingMailsSplitPanel")) {
                insertTab(Lang.getInstance().translate("Outcoming Mails"), new OutcomingMailsSplitPanel(), OutcomingMailsSplitPanel.getIcon());
                return;
            }
            if (str.equals(Lang.getInstance().translate("Send Mail")) || str.equals("MailSendPanel")) {
                insertTab(Lang.getInstance().translate("Send Mail"), new MailSendPanel(null, null, null), MailSendPanel.getIcon());
                return;
            }

            if (str.equals(Lang.getInstance().translate("Favorite Assets")) || str.equals("AssetsFavoriteSplitPanel")) {
                insertTab(Lang.getInstance().translate("Favorite Assets"), new AssetsFavoriteSplitPanel(), AssetsFavoriteSplitPanel.getIcon());
                return;
            }

            if (str.equals(Lang.getInstance().translate("My Assets")) || str.equals("AssetsMySplitPanel")) {
                ///insertTab(Lang.getInstance().translate("My Assets"), new MyAssetsTab(), MyAssetsTab.getIcon());
                insertTab(Lang.getInstance().translate("My Assets"), new AssetsMySplitPanel(), AssetsMySplitPanel.getIcon());
                return;
            }
            if (str.equals(Lang.getInstance().translate("Search Assets")) || str.equals("SearchAssetsSplitPanel")) {
                insertTab(Lang.getInstance().translate("Search Assets"), new SearchAssetsSplitPanel(true), SearchAssetsSplitPanel.getIcon());
                return;
            }
            if (str.equals(Lang.getInstance().translate("My Balance")) || str.equals("MyBalanceTab")) {
                insertTab(Lang.getInstance().translate("My Balance"), new MyBalanceTab(), MyBalanceTab.getIcon());
                return;
            }
            if (str.equals(Lang.getInstance().translate("My Orders")) || str.equals("MyOrderTab")) {
                insertTab(Lang.getInstance().translate("My Orders"), new MyOrderTab(), MyOrderTab.getIcon());
                return;
            }
            if (str.equals(Lang.getInstance().translate("Issue Asset")) || str.equals("IssueAssetPanel")) {
                insertTab(Lang.getInstance().translate("Issue Asset"), new IssueAssetPanel(), IssueAssetPanel.getIcon());
                return;
            } else if (str.equals(Lang.getInstance().translate("Exchange")) || str.equals("ExchangePanel")) {
                insertTab(Lang.getInstance().translate("Exchange"), new ExchangePanel(null, null, null, null), ExchangePanel.getIcon());
                return;
            } else if (str.equals(Lang.getInstance().translate("Withdraw Exchange")) || str.equals(WithdrawExchange.class.getSimpleName())) {
                insertTab(Lang.getInstance().translate("Withdraw Exchange"), new WithdrawExchange(null, null), WithdrawExchange.getIcon());
                return;
            }

            if (str.equals(Lang.getInstance().translate("Deposit Exchange")) || str.equals(DepositExchange.class.getSimpleName())) {
                insertTab(Lang.getInstance().translate("Deposit Exchange"), new DepositExchange(null, null), DepositExchange.getIcon());
                return;
            }


            if (str.equals(Lang.getInstance().translate("My Templates")) || str.equals("TemplateMySplitPanel")) {
                insertTab(Lang.getInstance().translate("My Templates"), new TemplateMySplitPanel(), TemplateMySplitPanel.getIcon());
                return;
            }
            if (str.equals(Lang.getInstance().translate("Search Templates")) || str.equals("SearchTemplatesSplitPanel")) {
                insertTab(Lang.getInstance().translate("Search Templates"), new SearchTemplatesSplitPanel(), SearchTemplatesSplitPanel.getIcon());
                return;
            }
            if (str.equals(Lang.getInstance().translate("Favorite Templates"))
                    || str.equals("TemplatesFavoriteSplitPanel")) {
                insertTab(Lang.getInstance().translate("Favorite Templates"), new TemplatesFavoriteSplitPanel(), TemplatesFavoriteSplitPanel.getIcon());
                return;
            }
            if (str.equals(Lang.getInstance().translate("Issue Template")) || str.equals("IssueTemplatePanel")) {
                insertTab(Lang.getInstance().translate("Issue Template"), new IssueTemplatePanel(), IssueTemplatePanel.getIcon());
                return;
            }
            if (str.equals(Lang.getInstance().translate("Create Status")) || str.equals("IssueStatusPanel")) {
                insertTab(Lang.getInstance().translate("Create Status"), new IssueStatusPanel(), IssueStatusPanel.getIcon());
                return;
            }
            if (str.equals(Lang.getInstance().translate("Favorite Statuses"))
                    || str.equals("StatusesFavoriteSplitPanel")) {
                insertTab(Lang.getInstance().translate("Favorite Statuses"), new StatusesFavoriteSplitPanel(), StatusesFavoriteSplitPanel.getIcon());
                return;
            }
            if (str.equals(Lang.getInstance().translate("Search Statuses")) || str.equals("SearchStatusesSplitPanel")) {
                insertTab(Lang.getInstance().translate("Search Statuses"), new SearchStatusesSplitPanel(), SearchStatusesSplitPanel.getIcon());
                return;
            }
            if (BlockChain.TEST_MODE) {
                if (str.equals(Lang.getInstance().translate("My Unions")) || str.equals("MyUnionsTab")) {
                    insertTab(Lang.getInstance().translate("My Unions"), new MyUnionsTab(), MyUnionsTab.getIcon());
                    return;
                }
                if (str.equals(Lang.getInstance().translate("Search Unions")) || str.equals("SearchUnionSplitPanel")) {
                    insertTab(Lang.getInstance().translate("Search Unions"), new SearchUnionSplitPanel(), SearchUnionSplitPanel.getIcon());
                    return;
                }
                if (str.equals(Lang.getInstance().translate("Issue Union")) || str.equals("IssueUnionPanel")) {
                    insertTab(Lang.getInstance().translate("Issue Union"), new IssueUnionPanel(), IssueUnionPanel.getIcon());
                    return;
                }
            }

            /////// POLLS
            if (str.equals(Lang.getInstance().translate("Favorite Polls")) || str.equals("PollsFavoriteSplitPanel")) {
                insertTab(Lang.getInstance().translate("Favorite Polls"), new PollsFavoriteSplitPanel(), PollsFavoriteSplitPanel.getIcon());
                return;
            }
            if (str.equals(Lang.getInstance().translate("My Polls")) || str.equals("Polls_My_SplitPanel")) {
                insertTab(Lang.getInstance().translate("My Polls"), new Polls_My_SplitPanel(), Polls_My_SplitPanel.getIcon());
                return;
            }
            if (str.equals(Lang.getInstance().translate("Search Polls")) || str.equals("SearchPollsSplitPanel")) {
                insertTab(Lang.getInstance().translate("Search Polls"), new SearchPollsSplitPanel(), SearchPollsSplitPanel.getIcon());
                return;
            }
            if (str.equals(Lang.getInstance().translate("Issue Poll")) || str.equals("IssuePollPanel")) {
                insertTab(Lang.getInstance().translate("Issue Poll"), new IssuePollPanel(), IssuePollPanel.getIcon());
                return;
            }


            //////// TRANSACTIONS
            if (str.equals(Lang.getInstance().translate("Favorite Records")) || str.equals("FavoriteTransactionsSplitPanel")) {
                insertTab(Lang.getInstance().translate("Favorite Records"), new FavoriteTransactionsSplitPanel(), FavoriteTransactionsSplitPanel.getIcon());
                return;
            }
            if (str.equals(Lang.getInstance().translate("My Records")) || str.equals("MyTransactionsSplitPanel")) {
                insertTab(Lang.getInstance().translate("My Records"), MyTransactionsSplitPanel.getInstance(), MyTransactionsSplitPanel.getIcon());
                return;
            }
            if (str.equals(Lang.getInstance().translate("Search Records")) || str.equals("SearchTransactionsSplitPanel")) {
                insertTab(Lang.getInstance().translate("Search Records"), new SearchTransactionsSplitPanel(), SearchTransactionsSplitPanel.getIcon());
                return;
            }
            if (str.equals(Lang.getInstance().translate("Unconfirmed Records"))
                    || str.equals("UnconfirmedTransactionsPanel")) {
                insertTab(Lang.getInstance().translate("Unconfirmed Records"), new UnconfirmedTransactionsPanel(), UnconfirmedTransactionsPanel.getIcon());
                return;
            }
            if (str.equals(Lang.getInstance().translate("Other")) || str.equals("OtherSplitPanel")) {
                insertTab(Lang.getInstance().translate("Other"), new OtherSplitPanel(), OtherSplitPanel.getIcon());

                return;
            }

            if (str.equals(Lang.getInstance().translate("Console")) || str.equals("OtherConsolePanel")) {
                insertTab(Lang.getInstance().translate("Console"), new OtherConsolePanel(), OtherConsolePanel.getIcon());

                return;
            }

            if (str.equals(Lang.getInstance().translate("Blocks")) || str.equals("OtherSearchBlocks")) {
                insertTab(Lang.getInstance().translate("Blocks"), new OtherSearchBlocks(), OtherSearchBlocks.getIcon());

                return;
            }

            /// UNIQUE HASHES
            if (str.equals(Lang.getInstance().translate("Favorite Unique Hashes"))
                    || str.equals("ImprintsFavoriteSplitPanel")) {
                insertTab(Lang.getInstance().translate("Favorite Unique Hashes"), new ImprintsFavoriteSplitPanel(), ImprintsFavoriteSplitPanel.getIcon());

                return;
            }
            if (str.equals(Lang.getInstance().translate("My Unique Hashes")) || str.equals("MyImprintsTab")) {
                insertTab(Lang.getInstance().translate("My Unique Hashes"), new MyImprintsTab(), MyImprintsTab.getIcon());

                return;
            }
            if (str.equals(Lang.getInstance().translate("Search Unique Hashes"))
                    || str.equals("ImprintsSearchSplitPanel")) {
                insertTab(Lang.getInstance().translate("Search Unique Hashes"), new ImprintsSearchSplitPanel(), ImprintsSearchSplitPanel.getIcon());

                return;
            }
            if (str.equals(Lang.getInstance().translate("Issue Unique Hash")) || str.equals("IssueImprintPanel")) {
                insertTab(Lang.getInstance().translate("Issue Unique Hash"), new IssueImprintPanel(), IssueImprintPanel.getIcon());

                return;
            }

            if (str.equals(Lang.getInstance().translate("Issue Linked Hash")) || str.equals("IssueLinkedHashPanel")) {
                insertTab(Lang.getInstance().translate("Issue Linked Hash"), new IssueLinkedHashPanel(), IssueLinkedHashPanel.getIcon());

                return;
            }

            if (str.equals(Lang.getInstance().translate("Search Linked Hash")) || str.equals("SearchTransactionsSplitPanel")) {
                insertTab(Lang.getInstance().translate("Search Linked Hash"), new SearchTransactionsSplitPanel(), SearchTransactionsSplitPanel.getIcon());
                return;
            }


            if (BlockChain.TEST_MODE) {
                if (str.equals(Lang.getInstance().translate("Wallets Manager"))
                        || str.equals("WalletsManagerSplitPanel")) {
                    insertTab(Lang.getInstance().translate("Wallets Manager"), new WalletsManagerSplitPanel(), WalletsManagerSplitPanel.getIcon());
                    return;
                }

            }

            if (str.equals(Lang.getInstance().translate("Telegrams Panel"))
                    || str.equals("TelegramSplitPanel")) {
                insertTab(Lang.getInstance().translate("Telegrams Panel"), new TelegramSplitPanel(), TelegramSplitPanel.getIcon());

                return;
            }
            if (str.equals(Lang.getInstance().translate("All Telegrams Panel"))
                    || str.equals("ALLTelegramPanel")) {
                insertTab(Lang.getInstance().translate("All Telegrams Panel"), new ALLTelegramPanel(), ALLTelegramPanel.getIcon());
                return;
            }
        } catch (Exception e) {
            logger.error(e.getMessage(), e);
        }

    }

    /**
     * If already opened - show it
     *
     * @param str
     * @param pp
     * @param im
     * @return
     */
    public boolean insertTab(String str, JPanel pp, Image im) {
        int index = jTabbedPane1.indexOfTab(str);
        boolean inserted = false;
        if (index == -1) {
            jTabbedPane1.addTabWithCloseButton(str, im, (JPanel) pp);
            index = jTabbedPane1.indexOfTab(str);
            inserted = true;
        }
        jTabbedPane1.setSelectedIndex(index);

        return inserted;

    }

    /**
     * If already opened - close first it and open anew
     *
     * @param str
     * @param pp
     * @param im
     */
    public void insertNewTab(String str, JPanel pp, Image im) {
        int index = jTabbedPane1.indexOfTab(str);
        if (index >= 0) {
            jTabbedPane1.remove(index);
        }
        jTabbedPane1.addTabWithCloseButton(str, im, (JPanel) pp);
        index = jTabbedPane1.indexOfTab(str);
        jTabbedPane1.setSelectedIndex(index);

    }


    // insert tab in tabbedpane
    public void renameTab(String oldTitle, String newTitle) {
        int index = jTabbedPane1.indexOfTab(oldTitle);
        if (index > 0) {
            jTabbedPane1.setTitleAt(index, newTitle);
            jTabbedPane1.getComponentAt(index).setName(newTitle);
        }

    }

    public void removeTab(String title) {
        int index = jTabbedPane1.indexOfTab(title);
        if (index > 0) {
            jTabbedPane1.remove(index);
        }
    }

    // get node by name
    private DefaultMutableTreeNode getNodeByName(String sNodeName, DefaultMutableTreeNode parent) {
        if (parent != null)
            for (Enumeration e = parent.breadthFirstEnumeration(); e.hasMoreElements(); ) {
                DefaultMutableTreeNode current = (DefaultMutableTreeNode) e.nextElement();
                if (sNodeName.equals(current.getUserObject())) {
                    return current;
                }
            }
        return null;
    }

}
